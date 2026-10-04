/**
 * `/swarm epic` — plan-scoped Epic lifecycle and diagnostics (Epic v2 C1a).
 *
 * Subcommands:
 *   /swarm epic start [--force] — open an epic for the current plan (see
 *                            `src/turbo/epic/start.ts` for the refusals)
 *   /swarm epic close [--abandon] — close the open epic (C1a: no landing)
 *                            and write its close report
 *   /swarm epic           — same as `status` (the bare form never mutates
 *                            the epic)
 *   /swarm epic status    — lifecycle state, orphan detection, sentinel/row
 *                            repair, recorded worktree merge failures, and
 *                            the one-time retirement of Epic v1 session state
 *   /swarm epic last      — most recent decision from the durable evidence log
 *   /swarm epic calibration — Capability D calibration state
 *   /swarm epic clear-merge-failure <taskId> [--confirm]
 *                          — clear a recorded worktree merge failure that
 *                            blocks Rule 2 (read-only without --confirm)
 *   /swarm epic decide    — run the activation decision once and print the
 *                            verdict without dispatching execution
 *                            (read-only what-if; does NOT write to
 *                             `.swarm/evidence/epic-promotions.jsonl`)
 *
 * The Epic v1 `on` / `off` per-session toggles were removed: an epic is
 * bound to one plan and every Epic behaviour is driven by the sentinel-first
 * project probe (`isEpicOpenForProject`). `close`, `status`, `last`,
 * `decide`, and `calibration` work regardless of the config gate.
 */

import { loadPluginConfigWithMeta } from '../config/index.js';
import { isGitRepo } from '../git/branch.js';
import { loadPlanJsonOnly } from '../plan/manager.js';
import {
	decideEpicActivation,
	type EpicActivationVerdict,
} from '../turbo/epic/activation.js';
import {
	isCalibrationStateUnreadable,
	loadCalibrationState,
} from '../turbo/epic/calibration.js';
import { closeEpic } from '../turbo/epic/close.js';
import { getCoChangeData } from '../turbo/epic/cochange-source.js';
import {
	EPIC_MODE_CONFIG_DISABLED_MESSAGE,
	isEpicCochangeConfigEnabled,
} from '../turbo/epic/config-gate.js';
import type { CouplingTask } from '../turbo/epic/coupling-report.js';
import { resolveEpicDeclaredScopes } from '../turbo/epic/declared-scopes.js';
import { readDivergenceHistory } from '../turbo/epic/divergence-recorder.js';
import {
	describeLegacyEpicMigration,
	retireLegacyEpicSessionState,
} from '../turbo/epic/legacy-migration.js';
import {
	type EpicInspection,
	type EpicRecordV1,
	inspectEpic,
	repairEpicSentinel,
} from '../turbo/epic/lifecycle.js';
import {
	clearMergeFailureCommand,
	describeMergeFailuresForStatus,
} from '../turbo/epic/merge-epoch.js';
import { resolvePlanMarkerScope } from '../turbo/epic/plan-key.js';
import { readPromotionEvidence } from '../turbo/epic/promotion-evidence.js';
import {
	describeEpicSizingReason,
	type EpicSizingVerdict,
	summarizeEpicSizing,
} from '../turbo/epic/sizing.js';
import { startEpic } from '../turbo/epic/start.js';

/**
 * Test-only DI seam. Production code calls `_internals.fn(...)` so tests can
 * replace these without `mock.module` (AGENTS.md invariant 7).
 */
export const _internals = {
	loadPluginConfigWithMeta,
	loadPlanJsonOnly,
	getCoChangeData,
	decideEpicActivation,
	resolveEpicDeclaredScopes,
	readPromotionEvidence,
	loadCalibrationState,
	isCalibrationStateUnreadable,
	readDivergenceHistory,
	isGitRepo,
	resolvePlanMarkerScope,
	describeMergeFailuresForStatus,
	clearMergeFailureCommand,
	startEpic,
	closeEpic,
	inspectEpic,
	repairEpicSentinel,
	retireLegacyEpicSessionState,
};

const USAGE =
	'Usage:\n  /swarm epic start [--force] | close [--abandon] | status | decide | last | calibration | clear-merge-failure <taskId> [--confirm]\n  /swarm epic         (shows status)';

export async function handleEpicCommand(
	directory: string,
	args: string[],
	sessionID: string,
): Promise<string> {
	if (!sessionID || sessionID.trim() === '') {
		return 'Error: No active session context. Epic Mode requires an active session. Use /swarm epic from within an OpenCode session.';
	}
	const arg0 = args[0]?.toLowerCase();
	const flags = new Set(args.slice(1).map((arg) => arg.toLowerCase()));

	switch (arg0) {
		case 'start':
			return renderStart(directory, sessionID, flags);
		case 'close':
			return renderClose(directory, flags);
		case 'status':
		case undefined:
			// No argument → status (NOT a mutation of the epic). Toggle-by-
			// default created an infinite loop with weaker models (Kimi K2.6
			// observed) when the architect called `swarm_command
			// [command=epic]` without args to "check state".
			return await renderStatus(directory);
		case 'decide':
			return renderDecide(directory);
		case 'last':
			return renderLast(directory);
		case 'calibration':
			return renderCalibration(directory);
		case 'clear-merge-failure':
			return _internals.clearMergeFailureCommand(directory, args.slice(1));
		case 'on':
		case 'off':
			return `\`/swarm epic ${arg0}\` was removed in Epic v2: an epic is now bound to one plan. Use \`/swarm epic start\` to open an epic for the current plan and \`/swarm epic close\` to close it.\n\n${USAGE}`;
		default:
			return `Unknown subcommand '${arg0}'.\n\n${USAGE}`;
	}
}

function unknownFlags(flags: Set<string>, allowed: string): string[] {
	return [...flags].filter((flag) => flag !== allowed);
}

function renderSizingLines(sizing: EpicSizingVerdict): string[] {
	const lines = [`Sizing: ${summarizeEpicSizing(sizing)}.`];
	for (const reason of sizing.reasons) {
		lines.push(`- ${describeEpicSizingReason(reason, sizing)}`);
	}
	return lines;
}

async function renderStart(
	directory: string,
	sessionID: string,
	flags: Set<string>,
): Promise<string> {
	const unknown = unknownFlags(flags, '--force');
	if (unknown.length > 0) {
		return `Unknown option(s) for \`/swarm epic start\`: ${unknown.join(', ')}.\n\n${USAGE}`;
	}
	let result: Awaited<ReturnType<typeof startEpic>>;
	try {
		result = await _internals.startEpic({
			directory,
			sessionID,
			force: flags.has('--force'),
		});
	} catch (error) {
		return `Error starting the epic: ${error instanceof Error ? error.message : String(error)}`;
	}
	if (result.status === 'already-open') {
		return [
			`Epic \`${result.record.epicKey}\` is already open for this plan — nothing changed.`,
			'',
			'Run `/swarm epic status` for details.',
		].join('\n');
	}
	if (result.status === 'refused') {
		const lines = [`Epic not started — **${result.reason}**.`, ''];
		if (result.reason === 'epic-disabled-by-config') {
			lines.push(EPIC_MODE_CONFIG_DISABLED_MESSAGE);
			return lines.join('\n');
		}
		for (const detail of result.details) lines.push(`- ${detail}`);
		if (result.sizing && result.sizing.pendingTasks > 0) {
			lines.push(...renderSizingLines(result.sizing));
			lines.push(
				'',
				'This plan is not epic-sized — run it in Balanced (the standard serial flow). To open an epic anyway, rerun `/swarm epic start --force` (recorded as forced).',
			);
		}
		return lines.join('\n');
	}
	const record = result.record;
	const lines = [
		`Epic \`${record.epicKey}\` opened for plan \`${record.planId}\`${record.forced ? ' (**forced** — the plan is not epic-sized)' : ''}.`,
		'',
		...renderSizingLines(record.sizing),
		record.git.isRepo
			? `Execution: git, up to ${record.config.maxParallel} task(s) per wave; commits stay on the current branch${record.git.originalBranch ? ` (\`${record.git.originalBranch}\`)` : ''}.`
			: 'Execution: non-git project — serial, one task per wave.',
		'',
		'The architect now follows the Epic wave flow (Epic enables neither Lean nor Turbo; per-task QA is never waived). Close with `/swarm epic close` once every task is completed or closed.',
	];
	return lines.join('\n');
}

async function renderClose(
	directory: string,
	flags: Set<string>,
): Promise<string> {
	const unknown = unknownFlags(flags, '--abandon');
	if (unknown.length > 0) {
		return `Unknown option(s) for \`/swarm epic close\`: ${unknown.join(', ')}.\n\n${USAGE}`;
	}
	let result: Awaited<ReturnType<typeof closeEpic>>;
	try {
		result = await _internals.closeEpic({
			directory,
			abandon: flags.has('--abandon'),
		});
	} catch (error) {
		return `Error closing the epic: ${error instanceof Error ? error.message : String(error)}`;
	}
	switch (result.status) {
		case 'no-epic':
			return result.repairedSentinel
				? 'No epic is open. A stale Epic sentinel was removed.'
				: 'No epic is open.';
		case 'refused':
			return [
				`Epic not closed — **${result.reason}**.`,
				'',
				...result.details.map((detail) => `- ${detail}`),
			].join('\n');
		case 'repaired-unreadable':
			return `Unreadable Epic lifecycle state removed (${result.rowsDeleted.length} row(s)${result.sentinelDeleted ? ' and the sentinel' : ''}). No epic is open.`;
		case 'closed': {
			const tasks = result.report.tasks;
			return [
				`Epic \`${result.report.epicKey}\` closed (**${result.report.outcome}**).`,
				'',
				tasks
					? `Tasks: ${tasks.completed} completed, ${tasks.closed} closed, ${tasks.pending.length} pending (of ${tasks.total}).`
					: 'Tasks: not summarized (the plan no longer matches the epic).',
				`Report: \`.swarm/epic/reports/${result.report.reportKey}.json\` (kept across /swarm close at \`.swarm/epic-prior/reports/${result.report.reportKey}.json\`).`,
			].join('\n');
		}
	}
}

/**
 * Epic v2 C0: recorded worktree merge-back failures, classified against the
 * current plan's root time (stale ⇒ ignored by Rule 2; undated ⇒ blocking,
 * fail closed). Read-only; any failure to resolve the plan degrades to
 * "root unknown" (every failure reported as blocking).
 */
async function renderMergeFailureLines(directory: string): Promise<string[]> {
	let sinceMs: number | null = null;
	try {
		const plan = await _internals.loadPlanJsonOnly(directory);
		if (plan) {
			sinceMs = (await _internals.resolvePlanMarkerScope(directory, plan))
				.rootTimestampMs;
		}
	} catch {
		sinceMs = null;
	}
	try {
		return _internals.describeMergeFailuresForStatus(directory, sinceMs);
	} catch (err) {
		return [
			'',
			`Worktree merge failures could not be listed: ${err instanceof Error ? err.message : String(err)}`,
		];
	}
}

const ORPHAN_TEXT: Record<
	NonNullable<EpicInspection['orphanReason']>,
	string
> = {
	'plan-missing': 'the plan is missing',
	'plan-renamed-or-replaced':
		'the plan was renamed or replaced (its swarm/title identity changed)',
	'plan-ledger-replaced': 'the plan ledger was re-rooted (a new plan epoch)',
};

function renderRecordLines(
	record: EpicRecordV1,
	inspection: EpicInspection,
): string[] {
	const lines: string[] = [];
	const orphaned = inspection.orphanReason !== null;
	const state = orphaned
		? 'orphaned'
		: record.status === 'closing'
			? 'closing (interrupted — rerun `/swarm epic close`)'
			: 'open';
	lines.push(`Epic: \`${record.epicKey}\` — **${state}**`);
	lines.push(`- Plan: ${record.planId} (plan key ${record.planKey})`);
	lines.push(
		`- Started: ${record.startedAt}${record.forced ? ' (forced — not epic-sized)' : ''}`,
	);
	lines.push(
		`- Execution: ${record.git.isRepo ? `git (${record.config.isolation}), up to ${record.config.maxParallel} task(s) per wave` : 'non-git, serial (one task per wave)'}; commit policy ${record.config.commitPolicy}`,
	);
	lines.push(`- Sizing at start: ${summarizeEpicSizing(record.sizing)}`);
	if (orphaned && inspection.orphanReason) {
		lines.push(
			'',
			`⚠️ Orphaned: ${ORPHAN_TEXT[inspection.orphanReason]} since the epic started, so Epic behaviour is OFF for the current plan. Run \`/swarm epic close --abandon\` to close it.`,
		);
	}
	if (!inspection.configEnabled) {
		lines.push(
			'',
			'⚠️ `turbo.epic.mode.enabled` is not true: Epic behaviour is OFF while the config gate is closed. Re-enable it, or close the epic.',
		);
	}
	if (record.lastDecision) {
		const ld = record.lastDecision;
		lines.push('', '### Last activation decision');
		lines.push(`- **Decision:** ${ld.decision}`);
		lines.push(`- **p:** ${ld.p.toFixed(3)}`);
		if (ld.phase !== undefined) lines.push(`- Phase: ${ld.phase}`);
		lines.push(`- Decided at: ${ld.decidedAt}`);
		if (ld.blockingReasons.length > 0) {
			lines.push('- Blocking reasons:');
			for (const r of ld.blockingReasons) lines.push(`  - ${r}`);
		}
	}
	return lines;
}

async function renderStatus(directory: string): Promise<string> {
	const lines: string[] = ['## Epic Mode — Status', ''];
	const legacy = _internals.retireLegacyEpicSessionState(directory);
	let repair: ReturnType<typeof repairEpicSentinel> = 'none';
	try {
		repair = _internals.repairEpicSentinel(directory);
	} catch (error) {
		lines.push(
			`⚠️ Sentinel repair failed: ${error instanceof Error ? error.message : String(error)}`,
			'',
		);
	}
	let plan: Awaited<ReturnType<typeof loadPlanJsonOnly>> = null;
	try {
		plan = await _internals.loadPlanJsonOnly(directory);
	} catch {
		plan = null;
	}
	const inspection = _internals.inspectEpic(directory, plan);
	if (inspection.unreadable) {
		lines.push(
			`**Epic lifecycle state is unreadable** (${inspection.unreadable}). Epic behaviour is OFF (fail closed). Run \`/swarm epic close --abandon\` to delete the unreadable state, then \`/swarm epic start\` again.`,
		);
	} else if (inspection.record) {
		lines.push(...renderRecordLines(inspection.record, inspection));
	} else {
		lines.push(
			'No epic is open. Run `/swarm epic start` to open one for the current plan.',
		);
	}
	if (repair !== 'none') {
		const text: Record<Exclude<typeof repair, 'none'>, string> = {
			'removed-stale-sentinel':
				'Repaired: removed a stale sentinel (`.swarm/epic/epic.json`) with no lifecycle row.',
			'restored-sentinel':
				'Repaired: restored the missing sentinel (`.swarm/epic/epic.json`) from the open lifecycle row.',
			'rewrote-mismatched-sentinel':
				'Repaired: rewrote a sentinel that named a different epic than the lifecycle row.',
		};
		lines.push('', text[repair]);
	}
	lines.push(...describeLegacyEpicMigration(legacy));
	lines.push(...(await renderMergeFailureLines(directory)));
	return lines.join('\n');
}

/**
 * Phase 14 (B26): shared detail string for the greenfield-check line in
 * both `/swarm epic last` and `/swarm epic decide` outputs. Pre-Phase-14
 * both renderers branched on `passed` alone and rendered `missing
 * upstreams: <list>` for any failure — which printed an EMPTY list when
 * the gate failed purely on phantom deps (a Phase-13-B20 typo case),
 * leaving the architect with no clue why the gate demoted. This helper
 * surfaces phantom deps explicitly, with their own remediation hint.
 */
function formatGreenfieldDetail(input: {
	bypassedNoGit: boolean;
	passed: boolean;
	crossPhaseUpstreams: readonly string[];
	missingUpstreams: readonly string[];
	phantomDeps: readonly string[];
}): string {
	if (input.bypassedNoGit) {
		return 'bypassed — non-git project';
	}
	if (input.passed) {
		return input.crossPhaseUpstreams.length === 0
			? 'vacuous — no cross-phase upstreams to verify'
			: `cross-phase upstreams in git: ${input.crossPhaseUpstreams.join(', ')}`;
	}
	const parts: string[] = [];
	if (input.phantomDeps.length > 0) {
		const sample = input.phantomDeps.slice(0, 3).join(', ');
		const more =
			input.phantomDeps.length > 3
				? `, +${input.phantomDeps.length - 3} more`
				: '';
		parts.push(`phantom dep ids (fix the typo): ${sample}${more}`);
	}
	if (input.missingUpstreams.length > 0) {
		const sample = input.missingUpstreams.slice(0, 3).join(', ');
		const more =
			input.missingUpstreams.length > 3
				? `, +${input.missingUpstreams.length - 3} more`
				: '';
		parts.push(`missing upstreams (wait for commit): ${sample}${more}`);
	}
	return parts.length > 0
		? parts.join('; ')
		: 'fail — no diagnostic fields present (legacy record?)';
}

/**
 * Render whether the co-change signal fed `p`. Returns `null` for legacy
 * records that predate the field (nothing to say).
 */
function formatCochangeSignal(
	signal: EpicActivationVerdict['rationale']['pCheck']['cochangeSignal'],
): string | null {
	if (signal === 'disabled-by-config') {
		return 'co-change signal: disabled by config (`turbo.epic.cochange.enabled` is not true) — p reflects declared-path conflicts only';
	}
	if (signal === 'enabled') {
		return 'co-change signal: enabled';
	}
	return null;
}

function renderLast(directory: string): string {
	// `/swarm epic last` — shows the most recent decision from the durable
	// evidence log. Complements `/swarm epic status` (which reads in-memory
	// session state and only sees decisions made by this session) and
	// `/swarm epic decide` (a what-if that never writes evidence). `last`
	// is the user's escape hatch when the architect (e.g. Kimi K2.6) runs
	// `epic_decide_phase` but doesn't surface the verdict — they can pull
	// it from the log explicitly.
	let records: ReturnType<typeof _internals.readPromotionEvidence>;
	try {
		records = _internals.readPromotionEvidence(directory);
	} catch (err) {
		return `Error reading epic-promotions.jsonl: ${err instanceof Error ? err.message : String(err)}`;
	}
	if (records.length === 0) {
		return [
			'## Epic Mode — Last Decision',
			'',
			'No decisions recorded yet at `.swarm/evidence/epic-promotions.jsonl`.',
			'',
			'A record is appended every time the architect calls `epic_decide_phase`.',
			"If you expected one and there isn't, the architect likely didn't invoke it for this phase — run `/swarm epic decide` to preview what Epic Mode would decide right now.",
		].join('\n');
	}
	const last = records[records.length - 1]!;
	const lines: string[] = ['## Epic Mode — Last Decision', ''];
	lines.push(`- Decided at: ${last.timestamp}`);
	lines.push(`- Session: ${last.sessionID}`);
	if (last.phase !== undefined) lines.push(`- Phase: ${last.phase}`);
	lines.push(`- Decision: **${last.verdict.decision}**`);
	lines.push(`- p: ${last.verdict.p.toFixed(3)}`);
	if (last.verdict.blockingReasons.length > 0) {
		lines.push('- Blocking reasons:');
		for (const r of last.verdict.blockingReasons) lines.push(`  - ${r}`);
	}
	lines.push('');
	lines.push('### Gate-by-gate');
	const r = last.verdict.rationale;
	lines.push(
		`- **p-threshold**: ${r.pCheck.passed ? 'pass' : 'fail'} (p=${r.pCheck.p.toFixed(3)} vs threshold ${r.pCheck.threshold.toFixed(3)})`,
	);
	{
		const signalLine = formatCochangeSignal(r.pCheck.cochangeSignal);
		if (signalLine) lines.push(`- ${signalLine}`);
	}
	const hot = r.hotModuleCheck.touchedHotModules;
	lines.push(
		`- **hot-module**: ${r.hotModuleCheck.passed ? 'pass' : `fail — touched ${hot.slice(0, 3).join(', ')}${hot.length > 3 ? `, +${hot.length - 3} more` : ''}`}`,
	);
	// Phase 12 (B12): post-Phase-10 the greenfield gate decides via
	// predecessor evidence (cross-phase upstreams in git) rather than the
	// commit-count floor. The old "X commits observed, Y required" label
	// is meaningless under that model. Render the actual decision basis:
	// missing upstreams when failing, "vacuous" when there were no
	// cross-phase deps to check, or "bypassed (no git)" when Rule 1 fired.
	//
	// Phase 13 (B18): legacy records on disk (written before Phase 10
	// landed) lack `crossPhaseUpstreams` / `missingUpstreams`. Default to
	// `[]` so the renderer doesn't TypeError when surfacing them via
	// `/swarm epic last`. We don't try to reconstruct intent from those
	// records — just treat empty as "no upstream info recorded".
	{
		const g = r.greenfieldCheck;
		const crossPhaseUpstreams = g.crossPhaseUpstreams ?? [];
		const missingUpstreams = g.missingUpstreams ?? [];
		const phantomDeps = g.phantomDeps ?? [];
		lines.push(
			`- **greenfield (predecessor evidence)**: ${g.passed ? 'pass' : 'fail'} — ${formatGreenfieldDetail(
				{
					bypassedNoGit: g.bypassedNoGit === true,
					passed: g.passed,
					crossPhaseUpstreams,
					missingUpstreams,
					phantomDeps,
				},
			)}`,
		);
	}
	if (records.length > 1) {
		lines.push('');
		lines.push(
			`(History: ${records.length} decisions total in this directory's epic-promotions.jsonl)`,
		);
	}
	return lines.join('\n');
}

function renderCalibration(directory: string): string {
	// `/swarm epic calibration` — surfaces the full M4 self-calibration
	// state: the learned threshold override (vs. the static config), the
	// monotonically-growing hot-module additions, the consecutive-clean
	// counter, the count of processed divergence records, and a tail of
	// the divergent tasks that drove the threshold to where it is.
	//
	// This is the user's pull-on-demand visibility into the feedback loop:
	//  - WHY the activation threshold is below static (which divergent
	//    tasks tightened it)
	//  - WHICH modules have been auto-promoted to the hot-module list
	//    (one-way ratchet — never auto-shrinks)
	//  - HOW many clean tasks are needed before the next loosening (counter
	//    + window from config)
	if (_internals.isCalibrationStateUnreadable(directory)) {
		return [
			'## Epic Mode — Calibration',
			'',
			'⚠️ Calibration state file is unreadable (fail-closed).',
			'',
			'`.swarm/epic/calibration.json` exists but failed shape validation. The calibration engine is using the static config defaults for this directory until the file is repaired or removed.',
		].join('\n');
	}

	let state: ReturnType<typeof _internals.loadCalibrationState>;
	try {
		state = _internals.loadCalibrationState(directory);
	} catch (err) {
		return `Error reading calibration state: ${err instanceof Error ? err.message : String(err)}`;
	}

	// Static config for the comparison (so the user can see "current is
	// tighter than static by N points").
	const { config } = _internals.loadPluginConfigWithMeta(directory);
	const staticThreshold = config.turbo?.epic?.mode?.activation_threshold ?? 0.3;
	const calibrationCfg = config.turbo?.epic?.calibration;
	const loosenWindow = calibrationCfg?.loosen_window ?? 10;

	if (!state) {
		return [
			'## Epic Mode — Calibration',
			'',
			'No calibration state yet at `.swarm/epic/calibration.json`.',
			'',
			`Static activation threshold: ${staticThreshold.toFixed(3)} (from \`turbo.epic.mode.activation_threshold\`)`,
			'',
			'The calibration engine writes state on the first `epic_decide_phase` call that consumes a divergence record. Until then, the static threshold and an empty hot-module list are in effect.',
		].join('\n');
	}

	const effectiveThreshold =
		state.activationThresholdOverride ?? staticThreshold;
	const delta = staticThreshold - effectiveThreshold;

	const lines: string[] = ['## Epic Mode — Calibration', ''];
	lines.push('### Knobs');
	lines.push(`- Static threshold (config): ${staticThreshold.toFixed(3)}`);
	if (state.activationThresholdOverride !== undefined) {
		lines.push(
			`- **Effective threshold (learned)**: ${effectiveThreshold.toFixed(3)} — tightened by ${delta.toFixed(3)} from static`,
		);
	} else {
		lines.push(
			`- **Effective threshold**: ${effectiveThreshold.toFixed(3)} (using static — no calibration override)`,
		);
	}
	lines.push(
		`- Consecutive clean tasks: ${state.consecutiveCleanCount} / ${loosenWindow} (next loosening at ${loosenWindow})`,
	);
	lines.push(`- Processed divergence records: ${state.processedRecords}`);
	if (state.lastCalibrationAt) {
		lines.push(`- Last calibration at: ${state.lastCalibrationAt}`);
	}
	lines.push('');

	lines.push('### Hot-module additions (learned)');
	if (state.hotModuleAdditions.length === 0) {
		lines.push(
			"_None._ The calibration loop hasn't promoted any modules to the hot list yet.",
		);
	} else {
		const sample = state.hotModuleAdditions.slice(0, 10);
		for (const m of sample) lines.push(`- ${m}`);
		if (state.hotModuleAdditions.length > 10) {
			lines.push(`- _… +${state.hotModuleAdditions.length - 10} more_`);
		}
		lines.push('');
		lines.push(
			'_(Monotonically grows; never auto-shrinks. To remove an entry, edit `.swarm/epic/calibration.json` by hand and restart the session.)_',
		);
	}
	lines.push('');

	// Divergent-tail context — WHY the threshold tightened. Read at most
	// the tail of the divergence log so this is fast even on long-running
	// projects.
	let recentDivergent: ReturnType<typeof _internals.readDivergenceHistory> = [];
	try {
		const all = _internals.readDivergenceHistory(directory, { limit: 50 });
		recentDivergent = all.filter((r) => !r.isClean).slice(-5);
	} catch {
		// best-effort
	}

	lines.push('### Recent divergent tasks (tightened the threshold)');
	if (recentDivergent.length === 0) {
		lines.push(
			'_None recent._ Either no divergence has been recorded, or recent tasks have all been clean.',
		);
	} else {
		for (const r of recentDivergent) {
			const sample = r.undeclared.slice(0, 3).join(', ');
			const more =
				r.undeclared.length > 3 ? `, +${r.undeclared.length - 3} more` : '';
			lines.push(
				`- ${r.taskId} (${r.timestamp.slice(0, 19)}Z, ratio=${r.divergenceRatio.toFixed(2)}) — undeclared: ${sample}${more}`,
			);
		}
	}

	return lines.join('\n');
}

async function renderDecide(directory: string): Promise<string> {
	const plan = await _internals.loadPlanJsonOnly(directory);
	if (!plan) {
		return 'No plan found at `.swarm/plan.json`. Run `/swarm plan` first.';
	}
	const { config } = _internals.loadPluginConfigWithMeta(directory);
	const modeCfg = config.turbo?.epic?.mode;
	const cochangeCfg = config.turbo?.epic?.cochange;
	const activationThreshold = modeCfg?.activation_threshold ?? 0.3;
	const minCommitsForSignal = modeCfg?.min_commits_for_signal ?? 20;
	const cochangeNpmiThreshold = cochangeCfg?.threshold ?? 0.6;
	const cochangeMinCoChanges = cochangeCfg?.min_co_changes ?? 5;
	const cochangeEnabled = isEpicCochangeConfigEnabled(config);

	// ONE plan-identity + v2 binding-set read for every task (declared
	// scopes live only in the v2 binding store `declare_scope` writes).
	const declaredScopes = _internals.resolveEpicDeclaredScopes(
		directory,
		plan,
		plan.phases.flatMap((phase) => (phase.tasks ?? []).map((task) => task.id)),
	);
	const tasks: CouplingTask[] = [];
	for (const phase of plan.phases) {
		for (const task of phase.tasks) {
			const scopeFiles = declaredScopes[task.id] ?? [];
			const scope: string[] =
				scopeFiles.length > 0 ? scopeFiles : (task.files_touched ?? []);
			tasks.push({ id: task.id, scope });
		}
	}

	// Co-change signal only when `turbo.epic.cochange.enabled === true`;
	// otherwise path-only conflicts, recorded as `disabled-by-config`.
	const { pairs, commitsObserved } = cochangeEnabled
		? await _internals.getCoChangeData(directory)
		: { pairs: [], commitsObserved: 0 };

	// Phase 16 (C4.H2): include the Phase 10/13 gate inputs that the
	// real `epic_decide_phase` tool computes — `isGitProject` (Rule 1
	// bypass) and the calibration-extended hot-module set. Without
	// these, the what-if's verdict diverges from the actual tool: a
	// non-git project would show "demote (greenfield)" here but
	// "promote (bypassed)" from the tool. The plan-wide what-if can NOT
	// simulate per-phase cross-phase predecessor-evidence
	// (`crossPhaseUpstreams` / `phantomDeps`) because those depend on
	// which phase the architect intends to decide — for accurate
	// per-phase previews the user should invoke the `epic_decide_phase`
	// tool directly with a phase number. We surface this caveat in the
	// output so the what-if's scope is unambiguous.
	const isGitProject = (() => {
		try {
			return _internals.isGitRepo(directory);
		} catch {
			return false;
		}
	})();

	const verdict = _internals.decideEpicActivation(
		tasks,
		pairs,
		commitsObserved,
		{
			activationThreshold,
			minCommitsForSignal,
			cochangeNpmiThreshold,
			cochangeMinCoChanges,
			isGitProject,
			cochangeSignal: cochangeEnabled ? 'enabled' : 'disabled-by-config',
		},
	);
	const caveat =
		'\n\n_Note: `/swarm epic decide` is a plan-wide what-if. It does NOT simulate the per-phase predecessor-evidence check (Phase 10) or phantom-dep detection — for accurate per-phase decisions, call `epic_decide_phase(phase=N)` directly._';
	return formatVerdict(verdict) + caveat;
}

function formatVerdict(verdict: EpicActivationVerdict): string {
	const lines: string[] = ['## Epic Mode — Activation Decision', ''];
	lines.push(`**Decision:** \`${verdict.decision}\``);
	lines.push(`**p:** ${verdict.p.toFixed(3)}`);
	lines.push('');
	lines.push('### Gates');
	lines.push(
		`- p-threshold: **${verdict.rationale.pCheck.passed ? 'pass' : 'fail'}** (p=${verdict.rationale.pCheck.p.toFixed(3)}, threshold=${verdict.rationale.pCheck.threshold.toFixed(3)})`,
	);
	{
		const signalLine = formatCochangeSignal(
			verdict.rationale.pCheck.cochangeSignal,
		);
		if (signalLine) lines.push(`- ${signalLine}`);
	}
	lines.push(
		`- hot-module: **${verdict.rationale.hotModuleCheck.passed ? 'pass' : 'fail'}** (${verdict.rationale.hotModuleCheck.touchedHotModules.length} hot module(s) touched)`,
	);
	// Phase 12 (B12) / Phase 13 (B18) / Phase 14 (B26): same rendering
	// rationale, legacy-tolerance guard, AND phantom-dep surfacing as
	// the `renderLast` path above.
	{
		const g = verdict.rationale.greenfieldCheck;
		const crossPhaseUpstreams = g.crossPhaseUpstreams ?? [];
		const missingUpstreams = g.missingUpstreams ?? [];
		const phantomDeps = g.phantomDeps ?? [];
		lines.push(
			`- greenfield (predecessor evidence): **${g.passed ? 'pass' : 'fail'}** — ${formatGreenfieldDetail(
				{
					bypassedNoGit: g.bypassedNoGit === true,
					passed: g.passed,
					crossPhaseUpstreams,
					missingUpstreams,
					phantomDeps,
				},
			)}`,
		);
	}
	if (verdict.blockingReasons.length > 0) {
		lines.push('');
		lines.push('### Blocking reasons');
		for (const r of verdict.blockingReasons) lines.push(`- ${r}`);
	}
	lines.push('');
	lines.push(
		'_This was a read-only `/swarm epic decide` call — no execution was dispatched and no evidence file was written. To act on this verdict, the architect should declare scopes for all pending tasks, then call `epic_decide_phase` → `epic_plan_waves` → for each wave, dispatch one `Task` per `taskId` in a single message → per-task Stage A/B + `update_task_status(completed)` + `epic_record_divergence` → `epic_phase_review` → `phase_complete`._',
	);
	return lines.join('\n');
}
