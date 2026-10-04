/**
 * Epic v2 C2 — `epic_next_wave`: the single, idempotent way forward while an
 * epic is open. It replaces `epic_decide_phase`, `epic_plan_waves` and
 * `epic_record_divergence`.
 *
 * Each call, in order:
 *   1. refuses unless Epic is enabled by config and an epic is open for the
 *      current plan (`epic-disabled-by-config`, `epic-state-unreadable`,
 *      `epic-orphaned`, `no-open-epic`);
 *   2. blocks `epic-branch-mismatch` when HEAD left the epic branch (M-e);
 *   3. with a wave active — advance rule: the wave closes when every task is
 *      resolved (plan status completed — already gated by
 *      `update_task_status` — or closed, or removed from the plan) and none
 *      has a merge-back failure recorded since the wave was issued.
 *      Otherwise: `blocked` (`task-blocked`, `merge-failed`, `plan-revised`
 *      when an unresolved task moved to another phase — the wave is aborted)
 *      or `in-progress` (the same wave; idempotent). A closable wave is
 *      closed (`wave-close.ts`) and the call continues to the next wave;
 *   4. phases are iterations: the current phase is the first phase not
 *      recorded complete by `phase_complete`; a pending task in a complete
 *      phase
 *      blocks (`task-reopened` when the epic had resolved it, else
 *      `plan-revised`);
 *   5. every current-phase task resolved → `phase-ready-for-review` (then
 *      `epic_phase_review` → `phase_complete`); every phase complete →
 *      `epic-complete`;
 *   6. otherwise selects the next wave (`wave-select.ts`): `declare-scopes`,
 *      `blocked` (`predecessor-missing`, `task-blocked`, `git-failed`,
 *      `dirty-baseline`), or `dispatch` — the wave (frozen declared scopes,
 *      base HEAD) is CAS-written into the epic record (token-guarded) and
 *      returned with dispatch instructions.
 */

import { DEFAULT_LEAN_TURBO_CONFIG } from '../../config/constants.js';
import { loadPluginConfigWithMeta as loadPluginConfigWithMeta_import } from '../../config/index.js';
import type { Plan } from '../../config/plan-schema.js';
import type { PluginConfig } from '../../config/schema.js';
import { _internals as gitBranchInternals } from '../../git/branch.js';
import { readLedgerEvents as readLedgerEvents_import } from '../../plan/ledger.js';
import { loadPlanJsonOnly as loadPlanJsonOnly_import } from '../../plan/manager.js';
import { loadCalibrationState as loadCalibrationState_import } from './calibration.js';
import { effectiveHotModules } from './calibration-engine.js';
import { getCoChangeData as getCoChangeData_import } from './cochange-source.js';
import {
	EPIC_MODE_CONFIG_DISABLED_MESSAGE,
	isEpicCochangeConfigEnabled,
	isEpicModeConfigEnabled,
} from './config-gate.js';
import { resolveEpicDeclaredScopes as resolveEpicDeclaredScopes_import } from './declared-scopes.js';
import {
	checkEpicBranch as checkEpicBranch_import,
	listDirtyPathsOutsideSwarm as listDirtyPathsOutsideSwarm_import,
} from './epic-branch.js';
import {
	type EpicRecordV1,
	type EpicWaveRecord,
	getOpenEpic as getOpenEpic_import,
	inspectEpic as inspectEpic_import,
	isEpicPhaseDone,
	updateEpicRecord as updateEpicRecord_import,
} from './lifecycle.js';
import { relevantMergeFailureForProject as relevantMergeFailureForProject_import } from './merge-epoch.js';
import {
	buildDispatchInstructions,
	type EpicClosedWaveSummary,
	type EpicNextWaveResult,
	type EpicWaveView,
	predecessorMessage,
	refused,
	summarizeClosedWave,
	syncPhaseRecords,
	toWaveView,
} from './next-wave-format.js';
import {
	readPlanScopedCommittedTaskIds as readPlanScopedCommittedTaskIds_import,
	resolvePlanMarkerScope as resolvePlanMarkerScope_import,
	scrubTaskIdForGitSubject,
} from './plan-key.js';
import {
	applyWaveClose,
	computeWaveClose as computeWaveClose_import,
	feedEpicCalibration as feedEpicCalibration_import,
	releaseWaveAttribution as releaseWaveAttribution_import,
} from './wave-close.js';
import { selectNextEpicWave } from './wave-select.js';

export type { EpicNextWaveResult } from './next-wave-format.js';

/** Window of the plan-scoped marker scan (Rule 3 predecessor evidence). */
const MARKER_SCAN_MAX_COMMITS = 10_000;

/** DI seam (AGENTS.md invariant 7). Restore in `afterEach`. */
export const _internals = {
	loadPluginConfigWithMeta: loadPluginConfigWithMeta_import,
	loadPlanJsonOnly: loadPlanJsonOnly_import,
	readLedgerEvents: readLedgerEvents_import,
	getOpenEpic: getOpenEpic_import,
	inspectEpic: inspectEpic_import,
	updateEpicRecord: updateEpicRecord_import,
	checkEpicBranch: checkEpicBranch_import,
	listDirtyPathsOutsideSwarm: (directory: string): string[] =>
		listDirtyPathsOutsideSwarm_import(directory),
	readHead: (directory: string): string | null => {
		try {
			const head = gitBranchInternals
				.gitExec(['rev-parse', 'HEAD'], directory)
				.trim();
			return /^[0-9a-f]{7,64}$/.test(head) ? head : null;
		} catch {
			return null;
		}
	},
	resolveEpicDeclaredScopes: resolveEpicDeclaredScopes_import,
	relevantMergeFailureForProject: relevantMergeFailureForProject_import,
	resolvePlanMarkerScope: resolvePlanMarkerScope_import,
	readPlanScopedCommittedTaskIds: readPlanScopedCommittedTaskIds_import,
	loadCalibrationState: loadCalibrationState_import,
	getCoChangeData: getCoChangeData_import,
	computeWaveClose: computeWaveClose_import,
	feedEpicCalibration: feedEpicCalibration_import,
	releaseWaveAttribution: releaseWaveAttribution_import,
	now: (): number => Date.now(),
};

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isTaskResolved(status: string | undefined): boolean {
	return status === 'completed' || status === 'closed';
}

type PlanTask = Plan['phases'][number]['tasks'][number];

function findTask(
	plan: Plan,
	taskId: string,
): { task: PlanTask; phaseId: number } | null {
	for (const phase of plan.phases) {
		const task = (phase.tasks ?? []).find((t) => t.id === taskId);
		if (task) return { task, phaseId: phase.id };
	}
	return null;
}

async function describeNoEpic(directory: string): Promise<EpicNextWaveResult> {
	let inspection: ReturnType<typeof inspectEpic_import> | null = null;
	try {
		inspection = _internals.inspectEpic(directory);
	} catch {
		inspection = null;
	}
	if (inspection?.record && inspection.orphanReason) {
		return refused(
			'epic-orphaned',
			`The open epic \`${inspection.record.epicKey}\` no longer matches the current plan (${inspection.orphanReason}). Ask the user to run \`/swarm epic status\`, then \`/swarm epic close --abandon\`; until then run tasks per-task serially.`,
		);
	}
	if (inspection?.record?.status === 'closing') {
		return refused(
			'no-open-epic',
			`Epic \`${inspection.record.epicKey}\` is closing (an interrupted \`/swarm epic close\`). Ask the user to rerun \`/swarm epic close\`.`,
		);
	}
	return refused(
		'no-open-epic',
		'No epic is open for the current plan. Only the user opens one (`/swarm epic start`); until then run tasks per-task serially.',
	);
}

/** Run one `epic_next_wave` step for `directory` (see the module header). */
export async function runEpicNextWave(
	directory: string,
	sessionID: string | undefined,
): Promise<EpicNextWaveResult> {
	let config: PluginConfig;
	try {
		config = _internals.loadPluginConfigWithMeta(directory).config;
	} catch {
		return refused(
			'epic-disabled-by-config',
			EPIC_MODE_CONFIG_DISABLED_MESSAGE,
		);
	}
	if (!isEpicModeConfigEnabled(config)) {
		return refused(
			'epic-disabled-by-config',
			EPIC_MODE_CONFIG_DISABLED_MESSAGE,
		);
	}
	let epic: EpicRecordV1 | null;
	try {
		epic = _internals.getOpenEpic(directory);
	} catch (error) {
		return refused(
			'epic-state-unreadable',
			`${errorText(error)}. Ask the user to run \`/swarm epic status\` (diagnose) or \`/swarm epic close --abandon\` (repair); until then run tasks per-task serially.`,
		);
	}
	if (!epic) return describeNoEpic(directory);

	const branch = _internals.checkEpicBranch(directory, epic);
	if (!branch.ok) {
		return {
			status: 'blocked',
			reason: 'epic-branch-mismatch',
			details: { expected: branch.expected, actual: branch.actual },
			message: branch.message,
		};
	}
	let plan: Plan | null;
	try {
		plan = await _internals.loadPlanJsonOnly(directory);
	} catch {
		plan = null;
	}
	if (!plan) {
		return refused(
			'epic-orphaned',
			'The plan could not be loaded, so the open epic cannot be matched to it. Ask the user to run `/swarm epic status`.',
		);
	}

	// 3. Active wave: advance rule.
	let closedWave: EpicClosedWaveSummary | undefined;
	if (epic.activeWaveSeq !== null) {
		const advanced = await advanceActiveWave(
			directory,
			sessionID,
			config,
			epic,
			plan,
		);
		if ('result' in advanced) return advanced.result;
		epic = advanced.epic;
		closedWave = advanced.closedWave;
	}
	const withClosed = (result: EpicNextWaveResult): EpicNextWaveResult =>
		closedWave && result.status !== 'refused'
			? { ...result, closedWave }
			: result;

	// 4. Completed phases must stay complete.
	const reopened: string[] = [];
	const revised: string[] = [];
	for (const phase of plan.phases) {
		if (!isEpicPhaseDone(epic, phase)) continue;
		for (const task of phase.tasks ?? []) {
			if (isTaskResolved(task.status)) continue;
			(epic.tasks[task.id] ? reopened : revised).push(task.id);
		}
	}
	if (reopened.length > 0) {
		return withClosed({
			status: 'blocked',
			reason: 'task-reopened',
			details: { taskIds: reopened },
			message: `Task(s) ${reopened.join(', ')} were completed in an already-complete phase and are now open again. Epic runs phases in order, so they cannot join a new wave. Tell the user, then either finish each one again through the per-task flow (coder → Stage A → Stage B → update_task_status(completed)) or close it (update_task_status closed) if the user drops it; then call epic_next_wave.`,
		});
	}
	if (revised.length > 0) {
		return withClosed({
			status: 'blocked',
			reason: 'plan-revised',
			details: { taskIds: revised },
			message: `Task(s) ${revised.join(', ')} are open in a phase the epic already completed (added or reopened in the plan after its phase_complete). Epic runs phases in order. Ask the user whether to move them into the current or a later phase (save_plan) or close them; then call epic_next_wave.`,
		});
	}

	// 5. Phase gating.
	const current = plan.phases.find((phase) => !isEpicPhaseDone(epic, phase));
	if (!current) {
		return withClosed({
			status: 'epic-complete',
			message:
				'Every phase is complete. Tell the user the epic can be closed with `/swarm epic close` (it lands the epic branch and writes the report).',
		});
	}
	if ((current.tasks ?? []).every((task) => isTaskResolved(task.status))) {
		syncPhases(directory, epic, current.id, 'review');
		return withClosed({
			status: 'phase-ready-for-review',
			phase: current.id,
			message: `Every task of phase ${current.id} is resolved and all its waves are closed. Call epic_phase_review({ phase: ${current.id} }) ONCE — it dispatches the phase reviewer, then (if it approves) the phase critic. Both APPROVED → write the retrospective → phase_complete({ phase: ${current.id} }) → epic_next_wave. Otherwise fix the findings and re-run epic_phase_review.`,
		});
	}

	// 6. Next wave.
	return withClosed(
		await issueNextWave(directory, config, epic, plan, current.id),
	);
}

type AdvanceOutcome =
	| { result: EpicNextWaveResult }
	| { epic: EpicRecordV1; closedWave: EpicClosedWaveSummary | undefined };

async function advanceActiveWave(
	directory: string,
	sessionID: string | undefined,
	config: PluginConfig,
	epic: EpicRecordV1,
	plan: Plan,
): Promise<AdvanceOutcome> {
	const seq = epic.activeWaveSeq;
	const wave = epic.waves.find((w) => w.seq === seq);
	if (!wave || wave.status !== 'issued') {
		// Dangling pointer (should not happen): clear it and plan afresh.
		const repaired = _internals.updateEpicRecord(
			directory,
			epic.epicKey,
			(record) =>
				record.activeWaveSeq === seq
					? { ...record, activeWaveSeq: null }
					: record,
			epic.token,
		);
		if (!repaired) return { result: await describeNoEpic(directory) };
		return { epic: repaired, closedWave: undefined };
	}

	const blocked: string[] = [];
	const waiting: { taskId: string; state: string }[] = [];
	const moved: { taskId: string; phase: number }[] = [];
	for (const taskId of wave.taskIds) {
		const found = findTask(plan, taskId);
		if (!found) continue; // removed ⇒ resolved
		const status = found.task.status;
		if (isTaskResolved(status)) continue;
		if (found.phaseId !== wave.phase) {
			moved.push({ taskId, phase: found.phaseId });
		} else if (status === 'blocked') {
			blocked.push(taskId);
		} else {
			waiting.push({ taskId, state: status ?? 'pending' });
		}
	}
	if (moved.length > 0) {
		const reason = `plan revised: ${moved.map((m) => `${m.taskId} moved to phase ${m.phase}`).join(', ')}`;
		const aborted = _internals.updateEpicRecord(
			directory,
			epic.epicKey,
			(record) =>
				record.activeWaveSeq === wave.seq
					? {
							...record,
							activeWaveSeq: null,
							waves: record.waves.map((w) =>
								w.seq === wave.seq
									? { ...w, status: 'aborted' as const, abortReason: reason }
									: w,
							),
						}
					: record,
			epic.token,
		);
		if (!aborted) return { result: await describeNoEpic(directory) };
		return {
			result: {
				status: 'blocked',
				reason: 'plan-revised',
				details: { waveSeq: wave.seq, moved },
				message: `Wave ${wave.seq} was aborted: ${reason}. Let any coder still running for its tasks finish, tell the user, then call epic_next_wave to plan again.`,
			},
		};
	}
	if (blocked.length > 0) {
		return {
			result: {
				status: 'blocked',
				reason: 'task-blocked',
				details: { waveSeq: wave.seq, taskIds: blocked },
				message: `Wave ${wave.seq} cannot close: task(s) ${blocked.join(', ')} are blocked. Tell the user why, then fix each one (re-dispatch its coder, run Stage A/B, update_task_status completed) or close it with update_task_status(closed) if the user drops it; then call epic_next_wave.`,
			},
		};
	}

	const issuedMs = Date.parse(wave.issuedAt);
	const sinceMs = Number.isFinite(issuedMs) ? issuedMs : 0;
	const failures: {
		taskId: string;
		outcome: string;
		stage: string;
		message: string;
		at: number | null;
	}[] = [];
	for (const taskId of wave.taskIds) {
		// Closed (dropped) and removed tasks' work is not expected to land,
		// so a stranded worktree of theirs does not hold the wave.
		if (findTask(plan, taskId)?.task.status !== 'completed') continue;
		const failure = _internals.relevantMergeFailureForProject(
			directory,
			taskId,
			sinceMs,
		);
		if (failure) {
			failures.push({
				taskId,
				outcome: failure.outcome,
				stage: failure.stage,
				message: failure.message,
				at: failure.completedAt ?? failure.queuedAt ?? null,
			});
		}
	}
	if (failures.length > 0) {
		recordMergeFailureSnapshots(directory, epic, wave.seq, failures);
		return {
			result: {
				status: 'blocked',
				reason: 'merge-failed',
				details: { waveSeq: wave.seq, failures },
				message: `Wave ${wave.seq} cannot close: the worktree merge-back of ${failures.map((f) => `${f.taskId} (${f.outcome} at '${f.stage}')`).join(', ')} did not land, so that work is not in the epic branch. Tell the user; resolve the preserved worktree (\`/swarm lanes\`) and re-dispatch the task — a clean merge-back clears the record. If the work did land, the user can clear it with \`/swarm epic clear-merge-failure <taskId> --confirm\`. Then call epic_next_wave.`,
			},
		};
	}
	if (waiting.length > 0) {
		return {
			result: {
				status: 'in-progress',
				wave: toWaveView(wave, plan),
				waitingOn: waiting,
				message: `Wave ${wave.seq} is still running — waiting on ${waiting.map((w) => `${w.taskId} (${w.state})`).join(', ')}. Let each running coder finish; do not re-dispatch a task whose coder may still be running. If you are certain no coder was ever dispatched for a waiting task, dispatch it (one Task per taskId, in one message). After each coder returns run Stage A (pre_check_batch) → Stage B (reviewer + test_engineer) → update_task_status(completed). Then call epic_next_wave.`,
			},
		};
	}

	// Closable: compute, CAS-close, then (only if this call closed it) feed
	// calibration and release attribution.
	const nowIso = new Date(_internals.now()).toISOString();
	const computation = await _internals.computeWaveClose({
		directory,
		epic,
		wave,
		plan,
		sessionID,
		nowIso,
	});
	let closedHere = false;
	const updated = _internals.updateEpicRecord(
		directory,
		epic.epicKey,
		(record) => {
			const next = applyWaveClose(record, wave.seq, computation, nowIso);
			closedHere = next !== record;
			return next;
		},
		epic.token,
	);
	if (!updated) return { result: await describeNoEpic(directory) };
	const closedRecord = updated.waves.find((w) => w.seq === wave.seq) ?? wave;
	// Best-effort, AFTER the close is committed and only by the call that
	// closed the wave: a crash between the CAS above and these side effects
	// loses this wave's divergence records / calibration step (outcomes,
	// including `undeclared`, are already in the record) — never blocks.
	if (closedHere) {
		_internals.feedEpicCalibration({
			directory,
			config,
			plan,
			wave: closedRecord,
			divergence: computation.divergence,
			sessionID,
		});
		_internals.releaseWaveAttribution(directory, sessionID, wave.taskIds);
	}
	return {
		epic: updated,
		closedWave: summarizeClosedWave(closedRecord, computation.outcomes),
	};
}

function recordMergeFailureSnapshots(
	directory: string,
	epic: EpicRecordV1,
	seq: number,
	failures: {
		taskId: string;
		outcome: string;
		stage: string;
		message: string;
		at: number | null;
	}[],
): void {
	try {
		_internals.updateEpicRecord(
			directory,
			epic.epicKey,
			(record) => {
				const wave = record.waves.find((w) => w.seq === seq);
				if (!wave) return record;
				const merged = { ...(wave.mergeFailures ?? {}) };
				let changed = false;
				for (const f of failures) {
					const prior = merged[f.taskId];
					if (
						prior &&
						prior.outcome === f.outcome &&
						prior.stage === f.stage &&
						prior.at === f.at
					) {
						continue;
					}
					merged[f.taskId] = {
						outcome: f.outcome,
						stage: f.stage,
						message: f.message.slice(0, 500),
						at: f.at,
					};
					changed = true;
				}
				if (!changed) return record;
				return {
					...record,
					waves: record.waves.map((w) =>
						w.seq === seq ? { ...w, mergeFailures: merged } : w,
					),
				};
			},
			epic.token,
		);
	} catch {
		// Snapshot is outcome evidence only; the block itself is what matters.
	}
}

function syncPhases(
	directory: string,
	epic: EpicRecordV1,
	currentPhase: number,
	currentStatus: 'active' | 'review',
): void {
	const next = syncPhaseRecords(epic.phases, currentPhase, currentStatus);
	if (next === epic.phases) return;
	try {
		_internals.updateEpicRecord(
			directory,
			epic.epicKey,
			(record) => ({
				...record,
				phases: syncPhaseRecords(record.phases, currentPhase, currentStatus),
			}),
			epic.token,
		);
	} catch {
		// Bookkeeping only; the result still tells the architect what to do.
	}
}

/**
 * Tasks completed BEFORE the epic started. `/swarm epic start` refuses a
 * dirty tree, so their work is in HEAD even though no Epic (Rule 2) marker
 * was written for them — they need no marker as predecessor evidence. A task
 * counts when the epic never resolved it in a wave and either its phase was
 * already finished at start, or its last transition to `completed` in the
 * plan ledger predates the start (or it was saved completed, with no
 * transition at all).
 */
async function completedBeforeEpic(
	directory: string,
	epic: EpicRecordV1,
	plan: Plan,
): Promise<Set<string>> {
	const started = Date.parse(epic.startedAt);
	let events: Awaited<ReturnType<typeof readLedgerEvents_import>> = [];
	try {
		events = await _internals.readLedgerEvents(directory);
	} catch {
		events = [];
	}
	const lastCompleted = new Map<string, number>();
	for (const event of events) {
		if (
			event.event_type === 'task_status_changed' &&
			event.to_status === 'completed' &&
			typeof event.task_id === 'string'
		) {
			const at = Date.parse(event.timestamp);
			if (Number.isFinite(at)) lastCompleted.set(event.task_id, at);
		}
	}
	const result = new Set<string>();
	for (const phase of plan.phases) {
		const atStart = epic.phases[String(phase.id)]?.completeAtStart === true;
		for (const task of phase.tasks ?? []) {
			if (task.status !== 'completed' || epic.tasks[task.id]) continue;
			const at = lastCompleted.get(task.id);
			if (
				atStart ||
				at === undefined ||
				(Number.isFinite(started) && at < started)
			) {
				result.add(task.id);
			}
		}
	}
	return result;
}

async function issueNextWave(
	directory: string,
	config: PluginConfig,
	epic: EpicRecordV1,
	plan: Plan,
	phaseId: number,
): Promise<EpicNextWaveResult> {
	const phase = plan.phases.find((p) => p.id === phaseId);
	const batchIds = (phase?.tasks ?? [])
		.filter((task) => !isTaskResolved(task.status) && task.status !== 'blocked')
		.map((task) => task.id);
	const liveScopes = _internals.resolveEpicDeclaredScopes(
		directory,
		plan,
		batchIds,
	);

	// Predecessor evidence: current-plan completion markers (git only), read
	// once and only when an out-of-batch completed dependency exists.
	let isCommitted: (taskId: string) => boolean = () => true;
	if (epic.git.isRepo) {
		const needsEvidence = (phase?.tasks ?? []).some(
			(task) =>
				batchIds.includes(task.id) &&
				(task.depends ?? []).some(
					(dep) =>
						!batchIds.includes(dep) &&
						findTask(plan, dep)?.task.status === 'completed',
				),
		);
		if (needsEvidence) {
			try {
				const scope = await _internals.resolvePlanMarkerScope(directory, plan);
				const committed = _internals.readPlanScopedCommittedTaskIds(
					directory,
					scope,
					MARKER_SCAN_MAX_COMMITS,
				);
				const preEpic = await completedBeforeEpic(directory, epic, plan);
				isCommitted = (taskId) =>
					preEpic.has(taskId) ||
					committed.has(scrubTaskIdForGitSubject(taskId));
			} catch (error) {
				return {
					status: 'blocked',
					reason: 'git-failed',
					details: { error: errorText(error) },
					message: `Cannot verify that completed predecessor tasks are committed: the plan-scoped completion-marker read failed (${errorText(error)}). Usually transient (a git lock) — call epic_next_wave again. If git stays broken, tell the user to repair the repository.`,
				};
			}
		}
	}

	let hotModules: string[] = [];
	if (config.turbo?.epic?.calibration?.enabled !== false) {
		try {
			hotModules = effectiveHotModules(
				[],
				_internals.loadCalibrationState(directory),
			);
		} catch {
			hotModules = [];
		}
	}
	let cochange: Parameters<typeof selectNextEpicWave>[0]['cochange'] = null;
	if (isEpicCochangeConfigEnabled(config)) {
		const cfg = config.turbo?.epic?.cochange;
		try {
			const data = await _internals.getCoChangeData(directory);
			cochange = {
				pairs: data.pairs,
				threshold: {
					npmi: cfg?.threshold ?? 0.6,
					minCoChanges: cfg?.min_co_changes ?? 5,
				},
			};
		} catch {
			cochange = null;
		}
	}

	const selection = selectNextEpicWave({
		directory,
		plan,
		phaseId,
		liveScopes,
		maxParallel: epic.config.maxParallel,
		leanConfig: { ...DEFAULT_LEAN_TURBO_CONFIG, ...(config.turbo?.lean ?? {}) },
		isCommitted,
		hotModules,
		cochange,
	});
	switch (selection.kind) {
		case 'none':
			// Unreachable: the caller only plans a phase with unresolved tasks.
			return {
				status: 'phase-ready-for-review',
				phase: phaseId,
				message: `Phase ${phaseId} has no task left to run. Call epic_phase_review({ phase: ${phaseId} }).`,
			};
		case 'task-blocked':
			return {
				status: 'blocked',
				reason: 'task-blocked',
				details: { taskIds: selection.taskIds },
				message: `No task of phase ${phaseId} can run: ${selection.taskIds.join(', ')} ${selection.taskIds.length === 1 ? 'is' : 'are'} blocked and the rest depend on ${selection.taskIds.length === 1 ? 'it' : 'them'}. Tell the user why; fix each blocked task through the per-task flow, or close it (update_task_status closed) if the user drops it. Then call epic_next_wave.`,
			};
		case 'predecessor-missing':
			return {
				status: 'blocked',
				reason: 'predecessor-missing',
				details: { problems: selection.problems },
				message: predecessorMessage(selection.problems, epic.planKey),
			};
		case 'declare-scopes':
			return {
				status: 'declare-scopes',
				phase: phaseId,
				tasks: selection.tasks,
				message: `Before the next wave, call declare_scope once per task — one taskId per call — with the exact files each will touch, including the test files the test_engineer will write for it (start from suggestedFiles; keep scopes tight and disjoint; add replace_existing: true when re-declaring): ${selection.tasks.map((t) => t.taskId).join(', ')}. Then call epic_next_wave.`,
			};
		case 'wave':
			break;
	}

	if (epic.git.isRepo) {
		let dirty: string[];
		try {
			dirty = _internals.listDirtyPathsOutsideSwarm(directory);
		} catch (error) {
			return {
				status: 'blocked',
				reason: 'git-failed',
				details: { error: errorText(error) },
				message: `Cannot check the working tree before the next wave (git status failed: ${errorText(error)}). Call epic_next_wave again; if it persists, tell the user.`,
			};
		}
		if (dirty.length > 0) {
			return {
				status: 'blocked',
				reason: 'dirty-baseline',
				details: { files: dirty.slice(0, 20), total: dirty.length },
				message: `The working tree has ${dirty.length} uncommitted change(s) outside .swarm/ (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}) that no task's completion commit took (undeclared writes or manual edits). Coders need a clean baseline. Tell the user and ask them to commit (on the epic branch) or discard them; then call epic_next_wave.`,
			};
		}
	}

	const nowIso = new Date(_internals.now()).toISOString();
	const baseHead = epic.git.isRepo ? _internals.readHead(directory) : null;
	let issued: EpicWaveRecord | null = null;
	let existing: EpicWaveRecord | null = null;
	const updated = _internals.updateEpicRecord(
		directory,
		epic.epicKey,
		(record) => {
			issued = null;
			existing = null;
			if (record.activeWaveSeq !== null) {
				existing =
					record.waves.find((w) => w.seq === record.activeWaveSeq) ?? null;
				return record;
			}
			const seq = record.waves.reduce((max, w) => Math.max(max, w.seq), 0) + 1;
			const wave: EpicWaveRecord = {
				seq,
				phase: phaseId,
				kind: selection.waveKind,
				taskIds: selection.taskIds,
				files: selection.files,
				cochange: cochange
					? { pairs: selection.cochangePairs, threshold: cochange.threshold }
					: null,
				baseHead,
				issuedAt: nowIso,
				status: 'issued',
			};
			issued = wave;
			return {
				...record,
				waves: [...record.waves, wave],
				activeWaveSeq: seq,
				phases: syncPhaseRecords(record.phases, phaseId, 'active'),
			};
		},
		epic.token,
	);
	if (!updated) return describeNoEpic(directory);
	const concurrent = existing as EpicWaveRecord | null;
	if (!issued && concurrent) {
		return {
			status: 'in-progress',
			wave: toWaveView(concurrent, plan),
			waitingOn: concurrent.taskIds.map((taskId) => ({
				taskId,
				state: findTask(plan, taskId)?.task.status ?? 'removed',
			})),
			message: `Wave ${concurrent.seq} was issued concurrently and is in progress. Finish its tasks, then call epic_next_wave.`,
		};
	}
	const wave = issued as EpicWaveRecord | null;
	if (!wave) return describeNoEpic(directory);
	const view: EpicWaveView = toWaveView(wave, plan);
	return {
		status: 'dispatch',
		wave: view,
		instructions: buildDispatchInstructions(view),
	};
}
