/**
 * execute-journey-driver — shared fixture for the normal EXECUTE journey host
 * qualification family (issue #2666, Workstream H PR 13/15).
 *
 * Boots the REAL plugin (`OpenCodeSwarmPlugin.server()` via bootSwarmPluginHost)
 * against a disposable git-initialized temp project and drives every journey
 * stage through REGISTERED surfaces only — the host tool map
 * (`host.tool.<name>.execute(args, ctx)`) and the merged registered hook chain
 * (`host.hooks['tool.execute.before'/'after']`, `host.hooks['chat.message']`,
 * `host.hooks['event']`). Never direct `executeX()` factory calls: per-stage
 * composition through the registered surfaces is the exact deficiency the
 * issue reports (see 02-reproduction.md R2).
 *
 * Deterministic transport: the host client is constructor-injected
 * (`ScriptedHostClient` — the createIssue2469HostClient pattern; no
 * mock.module) and records every host call it receives; native-task child
 * outputs are scripted at the hook boundary. No live model, no network.
 *
 * Exports the pinned report contracts (plan Revision 3, R5/R9):
 *   validateJourneyReport — the completion validator: a stage evidenced only
 *     by stdout/process exit REJECTS the report (issue AC2/AC5).
 *   validateCanaryEvidence — canary evidence requires fixture_class
 *     'model-canary' + transport 'live-model'; a deterministic report can
 *     never satisfy canary evidence (issue AC2/AC6).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type BootedPluginHost, bootSwarmPluginHost } from './plugin-host';
import { canonicalMkdtemp } from './tmpdir';

// ---------------------------------------------------------------------------
// Pinned report contracts (R5/R9)
// ---------------------------------------------------------------------------

export interface JourneyStageEvidence {
	/** Durable artifact paths (relative to the fixture project) under .swarm/. */
	durableArtifacts: string[];
	/** Registered tool-call identifiers observed while driving the stage. */
	toolCallIds: string[];
	/** Structured result identifiers recorded for the stage (>=1 per stage). */
	resultIds: string[];
	/** Negative-control marker: stage represented ONLY by stdout/process exit. */
	stdoutOnly?: boolean;
}

export interface JourneyStageReport {
	name: string;
	startStatus: string;
	endStatus: string;
	evidence: JourneyStageEvidence;
}

export interface JourneyReport {
	schemaVersion: number;
	fixture_class: 'deterministic' | 'model-canary';
	/** The exact command / host journey that produced this report. */
	command: string;
	runtime: { bun: string; node: string };
	host: { platform: string; arch: string; pluginVersion: string };
	startedAt: string;
	endedAt: string;
	stages: JourneyStageReport[];
	planBinding: { planId: string; approvedPayloadHash: string } | null;
	executedCells: string[];
	labeledUnexecutedCells: string[];
	transport: 'scripted-client' | 'live-model';
}

export const JOURNEY_REPORT_SCHEMA_VERSION = 1;

export interface JourneyValidation {
	valid: boolean;
	reasons: string[];
	unevidencedStages: string[];
}

/**
 * The journey completion validator (issue AC5: "the host fixture must fail if
 * a stage is represented only by stdout or process exit"). A stage is
 * evidenced iff it carries at least one durable artifact OR at least one
 * recorded tool call AND structured result id. Anything else — including the
 * explicit stdoutOnly marker — is unevidenced and invalidates the report.
 */
export function validateJourneyReport(
	report: JourneyReport,
): JourneyValidation {
	const reasons: string[] = [];
	const unevidencedStages: string[] = [];
	for (const stage of report.stages) {
		const e = stage.evidence ?? {
			durableArtifacts: [],
			toolCallIds: [],
			resultIds: [],
		};
		const hasDurable = e.durableArtifacts.length > 0;
		const hasStructuredReceipt =
			e.toolCallIds.length > 0 && e.resultIds.length > 0;
		if (e.stdoutOnly === true || (!hasDurable && !hasStructuredReceipt)) {
			unevidencedStages.push(stage.name);
			reasons.push(
				`unevidenced-stage:${stage.name}${
					e.stdoutOnly === true ? ' (stdout/process-exit only)' : ''
				}`,
			);
		}
	}
	if (report.stages.length === 0) {
		reasons.push('no-stages-recorded');
	}
	if (
		report.fixture_class === 'deterministic' &&
		report.stages.some((s) => s.name === 'finish') &&
		report.planBinding === null
	) {
		// A completed journey (one that reached finish) must carry the exact
		// approved-plan binding.
		reasons.push('missing-plan-binding');
	}
	if (
		report.transport === 'live-model' &&
		report.fixture_class === 'deterministic'
	) {
		reasons.push('fixture-class-transport-mismatch');
	}
	return { valid: reasons.length === 0, reasons, unevidencedStages };
}

/**
 * Canary evidence validator: only a model-backed canary run counts as canary
 * evidence. A deterministic (scripted-transport) report is rejected so a mock
 * can never masquerade as model quality (issue AC2/AC6).
 */
export function validateCanaryEvidence(report: JourneyReport): {
	valid: boolean;
	reasons: string[];
} {
	const reasons: string[] = [];
	if (report.fixture_class !== 'model-canary') {
		reasons.push('deterministic-report-is-not-canary-evidence');
	}
	if (report.transport !== 'live-model') {
		reasons.push('canary-evidence-requires-live-model-transport');
	}
	return { valid: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Deterministic scripted host client (constructor injection; no mock.module)
// ---------------------------------------------------------------------------

export interface ScriptedHostCall {
	surface: 'session.create' | 'session.promptAsync' | 'session.abort';
	detail: Record<string, unknown>;
	at: string;
}

export type PromptBehavior = (
	call: ScriptedHostCall,
) => Promise<Record<string, unknown>>;

/**
 * Scripted, recording host client speaking the real SDK response shapes
 * ({data, error}; session.create returns {data:{id}} — the
 * createIssue2469HostClient contract). Default behavior: session.create
 * returns fresh child ids and every promptAsync resolves with an empty
 * completion — tests override `promptBehavior` for verdicts, provider
 * failures, or never-resolving lanes (j03).
 */
export class ScriptedHostClient {
	public calls: ScriptedHostCall[] = [];
	public promptBehavior: PromptBehavior = async () => ({});
	private nextChild = 0;

	public readonly session = {
		create: async (
			input: Record<string, unknown>,
		): Promise<{ data: { id: string }; error: undefined }> => {
			this.nextChild += 1;
			const childId = `journey-child-${this.nextChild}`;
			this.calls.push({
				surface: 'session.create',
				detail: { input, childId },
				at: new Date().toISOString(),
			});
			return { data: { id: childId }, error: undefined };
		},
		promptAsync: async (
			input: Record<string, unknown>,
		): Promise<{ data: unknown; error: unknown }> => {
			const call: ScriptedHostCall = {
				surface: 'session.promptAsync',
				detail: { input },
				at: new Date().toISOString(),
			};
			this.calls.push(call);
			const behavior = await this.promptBehavior(call);
			return { data: behavior, error: undefined };
		},
		abort: async (
			input: Record<string, unknown>,
		): Promise<{ data: unknown; error: undefined }> => {
			this.calls.push({
				surface: 'session.abort',
				detail: { input },
				at: new Date().toISOString(),
			});
			return { data: undefined, error: undefined };
		},
		messages: async (
			input: Record<string, unknown>,
		): Promise<{ data: unknown[]; error: undefined }> => {
			this.calls.push({
				surface: 'session.messages',
				detail: { input },
				at: new Date().toISOString(),
			});
			// No messages: lanes stay pending until cancelled/settled. Tests
			// that need settled-lane harvesting override this via
			// `messagesBehavior`.
			return { data: this.messagesBehavior(), error: undefined };
		},
	};
	/** Override to script message lists for lane-state harvesting. */
	public messagesBehavior: () => unknown[] = () => [];
}

// ---------------------------------------------------------------------------
// Fixture project (disposable, git-initialized) + host boot
// ---------------------------------------------------------------------------

export interface JourneyProject {
	directory: string;
	cleanup: () => void;
}

function git(directory: string, args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		encoding: 'utf8',
		timeout: 10_000,
		maxBuffer: 256 * 1024,
		windowsHide: true,
	});
	if (result.status !== 0) {
		throw new Error(
			`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`,
		);
	}
}

/**
 * Create the disposable fixture project: temp dir, git repo with one committed
 * source file (the coder's edit target), `.swarm/` locally excluded. The
 * `.opencode/` config dir is created by bootSwarmPluginHost on boot.
 */
export function createJourneyProject(prefix: string): JourneyProject {
	const directory = canonicalMkdtemp(prefix);
	let cleaned = false;
	const cleanup = (): void => {
		if (cleaned) return;
		cleaned = true;
		try {
			spawnSync(
				process.platform === 'win32' ? 'cmd' : 'rm',
				process.platform === 'win32'
					? ['/c', `rmdir /s /q "${directory}"`]
					: ['-rf', directory],
				{ stdio: 'ignore', timeout: 10_000, windowsHide: true },
			);
		} catch {
			/* disposable; locked dirs are left behind */
		}
	};
	try {
		git(directory, ['init']);
		git(directory, ['config', 'user.email', 'journey@example.com']);
		git(directory, ['config', 'user.name', 'Journey Fixture']);
		mkdirSync(path.join(directory, 'src'), { recursive: true });
		writeFileSync(
			path.join(directory, 'src', 'feature.ts'),
			'export const feature = 1;\n',
		);
		writeFileSync(
			path.join(directory, 'src', 'util.ts'),
			'export const util = (): number => 42;\n',
		);
		git(directory, ['add', 'src/feature.ts', 'src/util.ts']);
		git(directory, ['commit', '-m', 'test: seed journey fixture repository']);
		const excludePath = path.join(directory, '.git', 'info', 'exclude');
		const existing = existsSync(excludePath)
			? readFileSync(excludePath, 'utf8')
			: '';
		if (!existing.split('\n').includes('.swarm/')) {
			writeFileSync(excludePath, `${existing}\n.swarm/\n`);
		}
	} catch (error) {
		cleanup();
		throw error;
	}
	return { directory, cleanup };
}

/** Commit all tracked working-tree changes (the between-rounds step a real
 * architect/coder performs before the next dispatch needs a clean baseline). */
export function commitWorkingTree(directory: string, message: string): void {
	git(directory, ['add', '-A', 'src']);
	const staged = spawnSync(
		'git',
		['-C', directory, 'diff', '--cached', '--quiet'],
		{ stdio: 'ignore', timeout: 10_000, windowsHide: true },
	);
	if (staged.status !== 0) git(directory, ['commit', '-m', message]);
}

/** Journey defaults merged under any test-provided config overrides. */
export const JOURNEY_CONFIG_DEFAULTS: Record<string, unknown> = {
	knowledge: { enabled: false, hive_enabled: false },
	hooks: { delegation_gate: true },
	worktree: { policy: 'disabled' },
};

export interface BootedJourneyHost {
	host: BootedPluginHost;
	directory: string;
	client: ScriptedHostClient;
}

/** Boot the real plugin server() with journey defaults + scripted client. */
export async function bootJourneyHost(options: {
	directory: string;
	client?: ScriptedHostClient;
	configOverrides?: Record<string, unknown>;
}): Promise<BootedJourneyHost> {
	const client = options.client ?? new ScriptedHostClient();
	// bootSwarmPluginHost writes .opencode/opencode-swarm.json but expects the
	// directory to exist (createPluginHostProject parity).
	mkdirSync(path.join(options.directory, '.opencode'), { recursive: true });
	const host = await bootSwarmPluginHost(
		options.directory,
		{ ...JOURNEY_CONFIG_DEFAULTS, ...(options.configOverrides ?? {}) },
		client,
	);
	// Exact-task settlement requires a CLEAN git launch baseline
	// (CODER_SETTLEMENT_CLEAN_BASELINE_REQUIRED): the project config the boot
	// just wrote must be committed before any coder dispatch. A second boot
	// over the same project re-writes an identical file — nothing stages, so
	// the commit is conditional.
	git(options.directory, ['add', '.opencode/opencode-swarm.json']);
	const staged = spawnSync(
		'git',
		['-C', options.directory, 'diff', '--cached', '--quiet'],
		{ stdio: 'ignore', timeout: 10_000, windowsHide: true },
	);
	if (staged.status !== 0) {
		git(options.directory, [
			'commit',
			'-m',
			'test: commit journey host config for clean settlement baseline',
		]);
	}
	return { host, directory: options.directory, client };
}

// ---------------------------------------------------------------------------
// Journey driver: stage recorder + registered-surface drive primitives
// ---------------------------------------------------------------------------

export type JourneyStageName =
	| 'configure'
	| 'discover'
	| 'specify'
	| 'approve'
	| 'execute'
	| 'pre-check'
	| 'reviewer'
	| 'qa'
	| 'finish'
	| 'restart'
	| 'inspect'
	| 'cancel';

/** A minimal single-task plan payload for the registered save_plan tool. */
export function journeyPlanArgs(
	options: { taskId?: string; file?: string } = {},
) {
	const taskId = options.taskId ?? '1.1';
	const file = options.file ?? 'src/feature.ts';
	return {
		title: 'Journey qualification fixture plan',
		swarm_id: 'journey-swarm',
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				tasks: [
					{
						id: taskId,
						description: 'Implement the fixture feature',
						acceptance: 'feature is implemented and verified',
						files_touched: [file],
					},
				],
			},
		],
	};
}

/** Parse a registered tool's JSON string envelope (or pass through objects). */
export function parseToolResult(raw: unknown): Record<string, unknown> {
	if (typeof raw === 'string')
		return JSON.parse(raw) as Record<string, unknown>;
	return (raw ?? {}) as Record<string, unknown>;
}

export class JourneyDriver {
	public readonly host: BootedPluginHost;
	public readonly directory: string;
	public readonly sessionID: string;
	public readonly client: ScriptedHostClient;
	public stages: JourneyStageReport[] = [];
	public planBinding: JourneyReport['planBinding'] = null;
	private readonly startedAt = new Date().toISOString();
	private callSeq = 0;

	constructor(input: BootedJourneyHost, sessionID = 'journey-architect') {
		this.host = input.host;
		this.directory = input.directory;
		this.client = input.client;
		this.sessionID = sessionID;
	}

	private nextCallId(stage: string): string {
		this.callSeq += 1;
		return `${stage}-call-${this.callSeq}`;
	}

	public beginStage(
		name: JourneyStageName,
		startStatus = 'started',
	): JourneyStageReport {
		const stage: JourneyStageReport = {
			name,
			startStatus,
			endStatus: '',
			evidence: { durableArtifacts: [], toolCallIds: [], resultIds: [] },
		};
		this.stages.push(stage);
		return stage;
	}

	public endStage(
		name: JourneyStageName,
		endStatus: string,
		evidence: Partial<JourneyStageEvidence>,
	): void {
		const stage = this.stages.find((s) => s.name === name);
		if (!stage) throw new Error(`endStage: stage ${name} not begun`);
		stage.endStatus = endStatus;
		stage.evidence = { ...stage.evidence, ...evidence };
	}

	// ---- configure ---------------------------------------------------------

	/** Fire the registered chat.message hook: the host's agent-turn surface. */
	public async configure(agent = 'architect'): Promise<JourneyStageReport> {
		this.beginStage('configure');
		const chat = this.host.hooks['chat.message'];
		if (typeof chat !== 'function')
			throw new Error('chat.message hook not registered');
		await chat(
			{ sessionID: this.sessionID, agent },
			{ message: { role: 'user' }, parts: [] },
		);
		const sessionStart = path.join('.swarm', 'session', 'session-start.jsonl');
		const artifacts: string[] = [];
		if (existsSync(path.join(this.directory, sessionStart))) {
			artifacts.push(sessionStart);
		}
		this.endStage('configure', 'agent-session-active', {
			durableArtifacts: artifacts,
			toolCallIds: [this.nextCallId('configure')],
			resultIds: ['chat.message:ok'],
		});
		return this.stages[this.stages.length - 1];
	}

	// ---- discover ----------------------------------------------------------

	/** Drive the registered repo_map tool (build, then query the fixture corpus). */
	public async discover(): Promise<Record<string, unknown>> {
		this.beginStage('discover');
		const repoMap = this.host.tool.repo_map;
		if (!repoMap) throw new Error('repo_map tool not registered');
		const ctx = { directory: this.directory, sessionID: this.sessionID };
		const buildRaw = await repoMap.execute({ action: 'build' }, ctx);
		const build = parseToolResult(buildRaw);
		const askRaw = await repoMap.execute(
			{ action: 'ask', query: 'feature' },
			ctx,
		);
		const ask = parseToolResult(askRaw);
		const artifacts: string[] = [];
		const graphPath = path.join('.swarm', 'repo-graph.json');
		if (existsSync(path.join(this.directory, graphPath)))
			artifacts.push(graphPath);
		this.endStage(
			'discover',
			build.success === false && ask.success === false
				? 'failed'
				: 'discovered',
			{
				durableArtifacts: artifacts,
				toolCallIds: [this.nextCallId('discover')],
				resultIds: [
					`repo_map:build:${build.success === false ? 'error' : 'ok'}`,
					`repo_map:ask:${ask.success === false ? 'error' : 'ok'}`,
				],
			},
		);
		return ask;
	}

	// ---- specify -----------------------------------------------------------

	/** Drive the registered save_plan tool. */
	public async specify(
		args: ReturnType<typeof journeyPlanArgs>,
	): Promise<Record<string, unknown>> {
		this.beginStage('specify');
		const savePlan = this.host.tool.save_plan;
		if (!savePlan) throw new Error('save_plan tool not registered');
		const raw = await savePlan.execute(
			{ ...args, directory: this.directory },
			{ directory: this.directory, sessionID: this.sessionID },
		);
		const parsed = parseToolResult(raw);
		this.endStage(
			'specify',
			parsed.success === false ? 'failed' : 'plan-saved',
			{
				durableArtifacts: [
					path.join('.swarm', 'plan.json'),
					path.join('.swarm', 'plan-ledger.jsonl'),
				].filter((rel) => existsSync(path.join(this.directory, rel))),
				toolCallIds: [this.nextCallId('specify')],
				resultIds: [
					`save_plan:${String(parsed.plan_id ?? parsed.message ?? 'result')}`,
				],
			},
		);
		return parsed;
	}

	// ---- approve -----------------------------------------------------------

	/**
	 * Drive the registered approve_plan_critic tool, then get_approved_plan to
	 * pin the EXACT approved-plan binding (planId + payload hash).
	 */
	public async approve(
		reason = 'journey fixture: critic verdict recorded',
	): Promise<{
		approval: Record<string, unknown>;
		binding: Record<string, unknown>;
	}> {
		this.beginStage('approve');
		const approve = this.host.tool.approve_plan_critic;
		const getApproved = this.host.tool.get_approved_plan;
		if (!approve || !getApproved) {
			throw new Error('approve_plan_critic / get_approved_plan not registered');
		}
		const approvalRaw = await approve.execute(
			{ reason },
			{ directory: this.directory, sessionID: this.sessionID },
		);
		const approval = parseToolResult(approvalRaw);
		const bindingRaw = await getApproved.execute(
			{ summary_only: true },
			{ directory: this.directory, sessionID: this.sessionID },
		);
		const binding = parseToolResult(bindingRaw);
		const approvedPayload = (binding.approved_plan ?? {}) as Record<
			string,
			unknown
		>;
		this.planBinding = {
			planId: String(approval.plan_id ?? 'unknown'),
			approvedPayloadHash: String(approvedPayload.payload_hash ?? 'unknown'),
		};
		this.endStage(
			'approve',
			approval.success === false ? 'failed' : 'plan-approved',
			{
				durableArtifacts: [path.join('.swarm', 'plan-ledger.jsonl')],
				toolCallIds: [this.nextCallId('approve')],
				resultIds: [
					`approve_plan_critic:${String(approval.plan_id ?? 'recorded')}`,
				],
			},
		);
		return { approval, binding };
	}

	// ---- EXECUTE (declare_scope + native-task simulation) ------------------

	/**
	 * Simulate the host's native Task call through the MERGED registered hook
	 * chain (guardrails + delegation gate both live in 'tool.execute.before'
	 * and 'tool.execute.after'). Between the hooks the fixture fires the
	 * registered `event` hook with a `message.part.updated` tool part — the
	 * exact host-side child-session correlation (parent on part.sessionID,
	 * child on state.metadata.sessionId, src/index.ts:3301-3355) — so the
	 * delegation gate's taskMetadata binding runs exactly as in a real host.
	 * `mutate` runs between the hooks like the child's file edit.
	 */
	public async driveTaskDelegation(input: {
		role: string;
		callID: string;
		taskId: string;
		file: string;
		mutate?: () => void;
		output: { state?: string; output?: string; error?: unknown };
	}): Promise<void> {
		const args = {
			subagent_type: input.role,
			task_id: input.taskId,
			prompt: `TASK: ${input.taskId}\nFILE: ${input.file}\nACCEPTANCE: ${input.role} work for ${input.taskId}`,
		};
		await this.host.hooks['tool.execute.before'](
			{ tool: 'Task', sessionID: this.sessionID, callID: input.callID },
			{ args },
		);
		const childSessionID = `journey-child-${input.role}-${input.callID}`;
		const eventHook = this.host.hooks['event'];
		if (typeof eventHook === 'function') {
			await eventHook({
				event: {
					type: 'message.part.updated',
					properties: {
						part: {
							type: 'tool',
							tool: 'task',
							callID: input.callID,
							sessionID: this.sessionID,
							state: { metadata: { sessionId: childSessionID } },
						},
					},
				},
			});
		}
		input.mutate?.();
		await this.host.hooks['tool.execute.after'](
			{ tool: 'Task', sessionID: this.sessionID, callID: input.callID, args },
			input.output,
		);
	}

	/** EXECUTE stage: declare_scope (registered v2 setter) + coder dispatch. */
	public async executeCoder(input: {
		taskId: string;
		file: string;
		mutate: () => void;
	}): Promise<Record<string, unknown>> {
		this.beginStage('execute', 'idle');
		const declareScope = this.host.tool.declare_scope;
		if (!declareScope) throw new Error('declare_scope tool not registered');
		const scopeRaw = await declareScope.execute(
			{ files: [input.file], task_id: input.taskId, replace_existing: true },
			{ directory: this.directory, sessionID: this.sessionID },
		);
		const scope = parseToolResult(scopeRaw);
		await this.driveTaskDelegation({
			role: 'coder',
			callID: `journey-coder-${input.taskId}`,
			taskId: input.taskId,
			file: input.file,
			mutate: input.mutate,
			output: { state: 'completed', output: `implemented ${input.taskId}` },
		});
		this.endStage('execute', 'coder_delegated', {
			durableArtifacts: [
				path.join('.swarm', 'evidence', `${input.taskId}.json`),
				path.join('.swarm', 'coder-settlements', `${input.taskId}.json`),
			].filter((rel) => existsSync(path.join(this.directory, rel))),
			toolCallIds: [this.nextCallId('execute')],
			resultIds: [`declare_scope:${scope.success === false ? 'error' : 'ok'}`],
		});
		return scope;
	}

	// ---- pre-check (Stage A) ------------------------------------------------

	/**
	 * Drive the registered pre_check_batch tool through the full hook chain —
	 * the #2664 registered-host pattern: the guardrails after-hook applies the
	 * Stage A receipt (stage_a_passed transition + route event).
	 */
	public async preCheck(input: {
		taskId: string;
		file: string;
	}): Promise<Record<string, unknown>> {
		this.beginStage('pre-check', 'coder_delegated');
		const preCheckTool = this.host.tool.pre_check_batch;
		if (!preCheckTool) throw new Error('pre_check_batch tool not registered');
		const callID = `journey-stage-a-${input.taskId}`;
		// pre_check_batch resolves paths from args.directory (its own arg
		// contract, pre-check-batch.ts:94) and takes the file list as
		// `files: string[]` — not changed_files.
		const args = {
			files: [input.file],
			directory: this.directory,
		};
		await this.host.hooks['tool.execute.before'](
			{ tool: 'pre_check_batch', sessionID: this.sessionID, callID },
			{ args },
		);
		const raw = await preCheckTool.execute(args, {
			directory: this.directory,
			sessionID: this.sessionID,
		});
		const parsed = parseToolResult(raw);
		await this.host.hooks['tool.execute.after'](
			{ tool: 'pre_check_batch', sessionID: this.sessionID, callID },
			{ title: '', output: JSON.stringify(parsed), metadata: null },
		);
		this.endStage(
			'pre-check',
			parsed.gates_passed ? 'stage_a_passed' : 'stage_a_failed',
			{
				durableArtifacts: [
					path.join('.swarm', 'evidence', `${input.taskId}.json`),
					path.join('.swarm', 'events.jsonl'),
				].filter((rel) => existsSync(path.join(this.directory, rel))),
				toolCallIds: [this.nextCallId('pre-check')],
				resultIds: [`pre_check_batch:${parsed.gates_passed ? 'pass' : 'fail'}`],
			},
		);
		return parsed;
	}

	// ---- reviewer / QA (Stage B) --------------------------------------------

	public async dispatchStageB(input: {
		role: 'reviewer' | 'test_engineer';
		taskId: string;
		file: string;
		verdictLine: string;
	}): Promise<void> {
		const name = input.role === 'reviewer' ? 'reviewer' : 'qa';
		this.beginStage(name, 'pre_check_passed');
		await this.driveTaskDelegation({
			role: input.role,
			callID: `journey-${input.role}-${input.taskId}`,
			taskId: input.taskId,
			file: input.file,
			output: {
				state: 'completed',
				output: `${input.verdictLine}\ndetails: ${input.role} completed for ${input.taskId}`,
			},
		});
		this.endStage(name, `stage_b_completed:${input.role}`, {
			durableArtifacts: [
				path.join('.swarm', 'evidence', `${input.taskId}.json`),
			].filter((rel) => existsSync(path.join(this.directory, rel))),
			toolCallIds: [this.nextCallId(name)],
			resultIds: [`${input.role}:${input.verdictLine.slice(1, 40)}`],
		});
	}

	// ---- finish / inspect ----------------------------------------------------

	public async finishTask(input: {
		taskId: string;
	}): Promise<Record<string, unknown>> {
		this.beginStage('finish', 'tests_run');
		const update = this.host.tool.update_task_status;
		if (!update) throw new Error('update_task_status tool not registered');
		const raw = await update.execute(
			{ task_id: input.taskId, status: 'completed' },
			{ directory: this.directory, sessionID: this.sessionID },
		);
		const parsed = parseToolResult(raw);
		this.endStage(
			'finish',
			parsed.success === false ? 'refused' : 'task_completed',
			{
				durableArtifacts: [
					path.join('.swarm', 'evidence', `${input.taskId}.json`),
					path.join('.swarm', 'plan-ledger.jsonl'),
				].filter((rel) => existsSync(path.join(this.directory, rel))),
				toolCallIds: [this.nextCallId('finish')],
				resultIds: [
					`update_task_status:${parsed.success === false ? 'refused' : 'completed'}`,
				],
			},
		);
		return parsed;
	}

	public async inspectTask(input: {
		taskId: string;
	}): Promise<Record<string, unknown>> {
		this.beginStage('inspect');
		const check = this.host.tool.check_gate_status;
		if (!check) throw new Error('check_gate_status tool not registered');
		const raw = await check.execute(
			{ task_id: input.taskId },
			{ directory: this.directory, sessionID: this.sessionID },
		);
		const parsed = parseToolResult(raw);
		this.endStage('inspect', 'inspected', {
			durableArtifacts: [
				path.join('.swarm', 'evidence', `${input.taskId}.json`),
			],
			toolCallIds: [this.nextCallId('inspect')],
			resultIds: [`check_gate_status:${String(parsed.status ?? 'result')}`],
		});
		return parsed;
	}

	// ---- report assembly ------------------------------------------------------

	public report(input: { command: string }): JourneyReport {
		return {
			schemaVersion: JOURNEY_REPORT_SCHEMA_VERSION,
			fixture_class: 'deterministic',
			command: input.command,
			runtime: {
				bun: String(process.versions.bun ?? 'n/a'),
				node: String(process.versions.node ?? 'n/a'),
			},
			host: {
				platform: process.platform,
				arch: process.arch,
				pluginVersion: 'opencode-swarm (repo build)',
			},
			startedAt: this.startedAt,
			endedAt: new Date().toISOString(),
			stages: this.stages,
			planBinding: this.planBinding,
			executedCells: [
				`bun/${process.platform}`,
				...this.client.calls.map((c) => `client:${c.surface}`),
			],
			labeledUnexecutedCells: [
				'node/full-journey',
				'macos/node',
				'linux/node',
				'live-model canary',
			],
			transport: 'scripted-client',
		};
	}

	/**
	 * Write the journey report under the TEMP project's .swarm/journey/ —
	 * fixture-local and disposable; the real repository's git status is never
	 * touched (plan R14).
	 */
	public async writeReport(input: {
		command: string;
		kind?: 'journey' | 'canary';
	}): Promise<string> {
		const report = this.report({ command: input.command });
		if (input.kind === 'canary') {
			report.fixture_class = 'model-canary';
			report.transport = 'live-model';
		}
		const dir = path.join(this.directory, '.swarm', 'journey');
		mkdirSync(dir, { recursive: true });
		const file = path.join(
			dir,
			`${input.kind === 'canary' ? 'canary' : 'journey'}-${Date.now()}.json`,
		);
		writeFileSync(file, JSON.stringify(report, null, 2));
		return file;
	}
}
