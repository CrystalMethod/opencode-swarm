/**
 * Epic Mode phase decision (Capability C).
 *
 * The architect-facing tool is `epic_decide_phase` (decide only). The
 * transparent flow is `declare_scope` (×N) → `epic_decide_phase` →
 * `epic_plan_waves` → per-wave `Task` dispatch → `epic_record_divergence`.
 * `executeEpicDecidePhase`:
 *
 *   1. Refuses when `turbo.epic.mode.enabled !== true` (config master gate)
 *      or Epic Mode is not on for the session (both fail closed).
 *   2. Loads the plan and resolves task scopes from the authoritative v2
 *      scope-binding store (what `declare_scope` writes), falling back to
 *      `files_touched`. Queries the co-change signal ONLY when
 *      `turbo.epic.cochange.enabled === true`; otherwise `p` is computed from
 *      declared-path conflicts alone and the rationale records
 *      `cochangeSignal: 'disabled-by-config'`.
 *   3. Runs `decideEpicActivation` over the WHOLE PLAN (per-plan
 *      activation per Q1) to get a `promote | demote` verdict.
 *   4. Appends one record to `.swarm/evidence/epic-promotions.jsonl` and
 *      mirrors the verdict into the open epic's record (`recordEpicLastDecision`).
 *
 * The tool never dispatches coders. The former opaque decide-and-dispatch
 * path (`executeEpicRunPhase`, which drove `LeanTurboRunner` and had no
 * ToolDefinition or production caller) was removed: the transparent wave
 * flow above is the only supported Epic dispatch path.
 */

import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { loadPluginConfigWithMeta as loadPluginConfigWithMeta_import } from '../config/index.js';
import { isSwarmSessionId } from '../config/swarm-branch.js';
import { isGitRepo as isGitRepo_import } from '../git/branch.js';
import { loadPlanJsonOnly as loadPlanJsonOnly_import } from '../plan/manager.js';
import type { EpicActivationVerdict } from '../turbo/epic/activation.js';
import { decideEpicActivation as decideEpicActivation_import } from '../turbo/epic/activation.js';
import {
	loadCalibrationState as loadCalibrationState_import,
	saveCalibrationState as saveCalibrationState_import,
} from '../turbo/epic/calibration.js';
import {
	applyCalibration as applyCalibration_import,
	effectiveActivationThreshold as effectiveActivationThreshold_import,
	effectiveHotModules as effectiveHotModules_import,
} from '../turbo/epic/calibration-engine.js';
import { getCoChangeData as getCoChangeData_import } from '../turbo/epic/cochange-source.js';
import {
	EPIC_MODE_CONFIG_DISABLED_MESSAGE,
	isEpicCochangeConfigEnabled,
	isEpicModeConfigEnabled,
} from '../turbo/epic/config-gate.js';
import type { CouplingTask } from '../turbo/epic/coupling-report.js';
import { resolveEpicDeclaredScopes as resolveEpicDeclaredScopes_import } from '../turbo/epic/declared-scopes.js';
import { readDivergenceHistory as readDivergenceHistory_import } from '../turbo/epic/divergence-recorder.js';
import { checkEpicBranch as checkEpicBranch_import } from '../turbo/epic/epic-branch.js';
import {
	type EpicRecordV1,
	getOpenEpic as getOpenEpic_import,
	recordEpicLastDecision as recordEpicLastDecision_import,
} from '../turbo/epic/lifecycle.js';
import { appendPromotionEvidence as appendPromotionEvidence_import } from '../turbo/epic/promotion-evidence.js';
import { buildIsUpstreamCommittedWithStatus as buildIsUpstreamCommittedWithStatus_import } from '../turbo/epic/upstream-commits.js';
import * as logger from '../utils/logger.js';
import { createSwarmTool } from './create-tool.js';

export interface EpicRunPhaseArgs {
	directory: string;
	phase: number;
	sessionID: string;
}

export interface EpicRunPhaseResult {
	success: boolean;
	/** The verdict for this run, persisted to evidence. */
	verdict?: EpicActivationVerdict;
	/**
	 * Either:
	 *  - `'decided'` — epic chose parallel (`promote`); the architect pairs
	 *    it with `epic_plan_waves` and dispatches each wave via `Task`.
	 *  - `'demoted'` — epic chose serial; the caller should fall back.
	 *  - `'epic-disabled-by-config'` — `turbo.epic.mode.enabled !== true`.
	 *  - `'epic-mode-not-active'` — no epic is open for the current plan.
	 *  - `'no-plan'` — `.swarm/plan.json` is missing.
	 *  - `'no-phase'` — the requested phase number isn't present in the
	 *    plan. Phase 12 (B11): without this, an unknown phase silently
	 *    produced `currentPhaseTasks = []` and vacuously-passed the
	 *    activation gate — promoting a phase that doesn't exist.
	 *  - `'phase-already-complete'` — every task in the requested phase
	 *    is already `status: 'completed'`. Phase 15 (B35): without this,
	 *    re-running an already-completed phase silently produced a
	 *    vacuous-pass `promote` verdict; the architect then called the
	 *    wave planner and got an empty plan with no diagnostic.
	 *  - `'phase-empty'` — the requested phase exists but its `tasks`
	 *    array is empty (architect created a phase header but never
	 *    populated it, or a council edit removed every task). Phase 17
	 *    (E.1): the Phase 15 B35 guard only fired when at least one
	 *    completed task existed; an empty `tasks: []` slipped through to
	 *    the same vacuous-pass `promote` B35 was supposed to prevent.
	 *  - `'scopes-missing'` — one or more pending tasks in the phase have
	 *    neither a live declared scope binding (undeclared, expired after
	 *    1 h, or declared against an older plan revision) nor
	 *    `files_touched` in plan.json. The wave planner needs scope data to
	 *    compute disjoint waves; without it the dispatch is silently
	 *    serial. The architect must re-run `declare_scope` for each missing
	 *    task and then re-invoke `epic_decide_phase`.
	 *  - `'epic-state-unreadable'` — the Epic lifecycle row is unreadable,
	 *    or `recordEpicLastDecision` failed (fail closed).
	 */
	reason: string;
	/** Set when `reason === 'epic-state-unreadable'`. */
	errors?: string[];
	/** Set when `reason === 'scopes-missing'` — the task ids with no scope. */
	missingScopes?: string[];
	/**
	 * Actionable message for the architect (set for `scopes-missing`,
	 * `epic-mode-not-active`, `epic-disabled-by-config`, and other preflight
	 * rejections).
	 */
	message?: string;
}

/**
 * Test-only DI seam. Mutating this object is file-scoped and trivially
 * restorable via afterEach, avoiding Bun's cross-file `mock.module`
 * leak (AGENTS.md invariant 7).
 */
export const _internals = {
	loadPluginConfigWithMeta: loadPluginConfigWithMeta_import,
	loadPlanJsonOnly: loadPlanJsonOnly_import,
	getCoChangeData: getCoChangeData_import,
	decideEpicActivation: decideEpicActivation_import,
	isGitRepo: isGitRepo_import,
	appendPromotionEvidence: appendPromotionEvidence_import,
	recordEpicLastDecision: recordEpicLastDecision_import,
	getOpenEpic: getOpenEpic_import,
	checkEpicBranch: checkEpicBranch_import,
	resolveEpicDeclaredScopes: resolveEpicDeclaredScopes_import,
	loadCalibrationState: loadCalibrationState_import,
	saveCalibrationState: saveCalibrationState_import,
	applyCalibration: applyCalibration_import,
	effectiveActivationThreshold: effectiveActivationThreshold_import,
	effectiveHotModules: effectiveHotModules_import,
	readDivergenceHistory: readDivergenceHistory_import,
	buildIsUpstreamCommittedWithStatus: buildIsUpstreamCommittedWithStatus_import,
};

/**
 * Decide-only path behind `epic_decide_phase`: runs the phase flow
 * (preflight + calibration + co-change + decision + evidence write + session
 * state mirror) and returns the verdict WITHOUT dispatching coders. The
 * architect then calls `epic_plan_waves` and dispatches each wave via Task
 * for visibility.
 *
 * Returns an EpicRunPhaseResult with:
 *  - reason: 'decided'  → verdict is promote, architect may dispatch waves.
 *  - reason: 'demoted'  → verdict is demote, caller falls back to serial.
 *
 * Error / non-decision reasons (all set success: false):
 *  - 'epic-disabled-by-config' — `turbo.epic.mode.enabled !== true`.
 *  - 'epic-mode-not-active' — no epic is open for the current plan.
 *  - 'epic-branch-mismatch' — the epic uses the epic-branch commit policy
 *    and HEAD is not its branch (EPIC_BRANCH_MISMATCH, fail closed).
 *  - 'no-plan' — `.swarm/plan.json` is missing.
 *  - 'no-phase' (Phase 12 B11) — the requested phase number isn't in the plan.
 *  - 'phase-empty' (Phase 17 E.1) — phase exists but has zero tasks.
 *  - 'phase-already-complete' (Phase 15 B35) — every task already completed.
 *  - 'scopes-missing' — one or more pending tasks lack a live declared scope.
 *  - 'epic-state-unreadable' — the Epic lifecycle row is unreadable, or
 *    `recordEpicLastDecision` failed (fail closed).
 */
export async function executeEpicDecidePhase(
	args: EpicRunPhaseArgs,
): Promise<EpicRunPhaseResult> {
	const { directory, phase, sessionID } = args;

	// Config master gate: `turbo.epic.mode.enabled` (default false). Loaded
	// once here and reused for the epic/cochange/calibration knobs below.
	// A config load failure fails CLOSED (Epic Mode is opt-in).
	let config: ReturnType<typeof _internals.loadPluginConfigWithMeta>['config'];
	try {
		config = _internals.loadPluginConfigWithMeta(directory).config;
	} catch {
		return {
			success: false,
			reason: 'epic-disabled-by-config',
			message: EPIC_MODE_CONFIG_DISABLED_MESSAGE,
		};
	}
	if (!isEpicModeConfigEnabled(config)) {
		return {
			success: false,
			reason: 'epic-disabled-by-config',
			message: EPIC_MODE_CONFIG_DISABLED_MESSAGE,
		};
	}

	let epic: EpicRecordV1 | null;
	try {
		epic = _internals.getOpenEpic(directory);
	} catch (err) {
		return {
			success: false,
			reason: 'epic-state-unreadable',
			errors: [err instanceof Error ? err.message : String(err)],
			message:
				'The Epic lifecycle state is unreadable (fail closed). Ask the user to run `/swarm epic status` (diagnose) or `/swarm epic close --abandon` (repair); until then execute the phase per-task serially.',
		};
	}
	if (!epic) {
		return {
			success: false,
			reason: 'epic-mode-not-active',
			message:
				'No epic is open for the current plan. Ask the user to run `/swarm epic start`, then retry; until then execute the phase per-task serially.',
		};
	}
	// Branch-drift guard (Epic v2 C1b, M-e): the epic's commits must land on
	// its epic branch, so HEAD must still be that branch.
	const branch = _internals.checkEpicBranch(directory, epic);
	if (!branch.ok) {
		return {
			success: false,
			reason: 'epic-branch-mismatch',
			message: branch.message,
		};
	}

	const plan = await _internals.loadPlanJsonOnly(directory);
	if (plan === null) {
		return { success: false, reason: 'no-plan' };
	}

	// ONE plan-identity + v2 binding-set read for the whole decision,
	// shared by the preflight and the plan-wide coupling inputs (#2532
	// hoisting). `declare_scope` persists only v2 bindings pinned to the
	// exact plan identity; the legacy v1 `.swarm/scopes/scope-<id>.json`
	// projection is never consulted.
	const declaredScopes = _internals.resolveEpicDeclaredScopes(
		directory,
		plan,
		plan.phases.flatMap((ph) => (ph.tasks ?? []).map((task) => task.id)),
	);

	// --- Preflight: every pending task in this phase must have a declared
	// scope (a live `declare_scope` binding for the current plan revision,
	// or `files_touched` in plan.json). The wave planner reads from this
	// scope graph; if it's empty, the planner has nothing to plan and
	// returns empty waves — which makes the promote verdict silently
	// meaningless and the architect typically falls back to serial.
	// Discovered live with Kimi K2.6 (fair-clinical-bench session): the
	// model decided without declaring scopes upfront, got an empty plan,
	// misdiagnosed it as "Epic Mode serialized everything", and ran tasks
	// one-by-one. The banner-mandate Step 0 fix proved insufficient —
	// tool-side enforcement is needed.
	const phaseInPlan = plan.phases.find((ph) => ph.id === phase);
	if (!phaseInPlan) {
		// Phase 12 (B11): explicit failure rather than the silent
		// vacuously-pass path. The activation gate's predecessor-evidence
		// check (Phase 10) iterates over the current phase's tasks; with
		// no phase to iterate, the upstream set is empty and the gate
		// passes — promoting a phase that doesn't exist in the plan.
		return {
			success: false,
			reason: 'no-phase',
			message: `Phase ${phase} is not present in plan.json. Available phases: ${plan.phases.map((p) => p.id).join(', ') || '(none)'}.`,
		};
	}
	{
		const pendingTasks = phaseInPlan.tasks.filter(
			(t) => t.status !== 'completed',
		);
		// Phase 17 (E.1): empty `tasks: []` is the OTHER vacuous-pass
		// path. The Phase 15 B35 guard only fired when at least one
		// completed task existed; an architect-created phase header with
		// no tasks populated still produced a `promote` verdict before
		// Phase 17. Surface it as its own reason so the architect can
		// either populate the phase or remove the empty header.
		if (phaseInPlan.tasks.length === 0) {
			return {
				success: false,
				reason: 'phase-empty',
				message:
					`Phase ${phase} has no tasks. The phase header exists in plan.json but no tasks are defined. ` +
					`Add tasks to this phase (with declared scopes, depends, and acceptance criteria) and re-invoke epic_decide_phase. ` +
					`Alternatively, if the phase was created by mistake, remove it from plan.json and decide on the next valid phase.`,
			};
		}
		// Phase 15 (B35): if EVERY task in the phase is already completed,
		// don't run the activation gate at all. Pre-Phase-15 the gate
		// returned a vacuous-pass `promote` because Phase 14's B29 filter
		// produced an empty dep set; the architect then called the wave
		// planner and got an empty wave plan with no diagnostic. The
		// right answer is "phase is already done — advance to the next
		// phase".
		if (pendingTasks.length === 0) {
			return {
				success: false,
				reason: 'phase-already-complete',
				message:
					`Phase ${phase} has no pending tasks — every task is already marked completed. ` +
					`Advance to the next phase (or re-open tasks by setting status back to "pending" if you intended to re-run them).`,
			};
		}
		const tasksMissingScope: string[] = [];
		for (const task of pendingTasks) {
			const declaredScope = declaredScopes[task.id] ?? [];
			const filesTouched = task.files_touched ?? [];
			if (declaredScope.length === 0 && filesTouched.length === 0) {
				tasksMissingScope.push(task.id);
			}
		}
		if (tasksMissingScope.length > 0) {
			const list = tasksMissingScope.join(', ');
			return {
				success: false,
				reason: 'scopes-missing',
				missingScopes: tasksMissingScope,
				message:
					`Cannot decide phase ${phase}: ${tasksMissingScope.length} pending task(s) ` +
					`have no live declared scope and no files_touched in plan.json. ` +
					`A declared scope is missing when it was undeclared, expired (bindings live 1h), ` +
					`or the plan was revised since declaration. ` +
					`The wave planner (\`epic_plan_waves\`) needs scope data to compute disjoint concurrent groups; ` +
					`without it the dispatch is silently serial and Epic Mode's parallelization is lost.\n\n` +
					`Missing scopes: ${list}\n\n` +
					`Resolution: re-run \`declare_scope\` once for EACH of those task ids, passing the exact ` +
					`file paths the task will touch. Then re-invoke \`epic_decide_phase(phase=${phase})\`.`,
			};
		}
	}

	// Epic + cochange knobs (safe defaults when keys are absent). `config`
	// was loaded once at the top for the master gate.
	const modeCfg = config.turbo?.epic?.mode;
	const cochangeCfg = config.turbo?.epic?.cochange;
	const calibrationCfg = config.turbo?.epic?.calibration;
	const staticActivationThreshold = modeCfg?.activation_threshold ?? 0.3;
	const minCommitsForSignal = modeCfg?.min_commits_for_signal ?? 20;
	const cochangeNpmiThreshold = cochangeCfg?.threshold ?? 0.6;
	const cochangeMinCoChanges = cochangeCfg?.min_co_changes ?? 5;
	const calibrationEnabled = calibrationCfg?.enabled !== false;
	const cochangeEnabled = isEpicCochangeConfigEnabled(config);

	// --- Capability D: roll calibration forward from any divergence records
	// observed since the last `epic_decide_phase` call. The engine is pure; the
	// only side effect is the calibration-state write at the end. Failure is
	// non-fatal — calibration is opportunistic, not load-bearing for safety.
	let effectiveThreshold = staticActivationThreshold;
	let extraHotModules: string[] = [];
	if (calibrationEnabled) {
		try {
			const currentCalibration = _internals.loadCalibrationState(directory);
			if (currentCalibration !== null) {
				// Full read: the calibration engine slices by record COUNT
				// (`processedRecords`), so a tail-truncated view would
				// silently miss records once the file exceeds the default
				// 16 MiB cap. Trade memory pressure for correctness here;
				// rotation/byte-offset tracking is a future enhancement.
				const history = _internals.readDivergenceHistory(directory, {
					maxBytes: Number.POSITIVE_INFINITY,
				});
				const newRecords = history.slice(currentCalibration.processedRecords);
				if (newRecords.length > 0) {
					const updated = _internals.applyCalibration(
						currentCalibration,
						newRecords,
						{
							staticThreshold: staticActivationThreshold,
							floorThreshold: calibrationCfg?.floor_threshold,
							tightenStep: calibrationCfg?.tighten_step,
							loosenStep: calibrationCfg?.loosen_step,
							loosenWindow: calibrationCfg?.loosen_window,
						},
					);
					let savedSuccessfully = false;
					try {
						_internals.saveCalibrationState(directory, updated);
						savedSuccessfully = true;
					} catch (err) {
						// Critical: if persistence failed we MUST NOT use the
						// in-memory `updated` for this run either. The next
						// `epic_decide_phase` would re-read the OLD `processedRecords`
						// from disk and re-apply the same divergence records,
						// causing silent threshold drift across repeated failures
						// (adversarial review H1). Sacrifice one run of new signal
						// to preserve correctness — fall back to the durable state.
						// Phase 16 (C1.H5): the "sacrifice one run" intentional
						// drop is exactly the operator-visible signal — without
						// this, calibration silently regresses to the durable
						// state with no surface indication. Pre-Phase-16 this
						// was `warn` (debug-gated).
						logger.criticalWarn(
							`[epic_decide_phase] calibration persist failed; ignoring this run's calibration delta to avoid drift on next run: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
					const sourceForThisRun = savedSuccessfully
						? updated
						: currentCalibration;
					effectiveThreshold = _internals.effectiveActivationThreshold(
						staticActivationThreshold,
						sourceForThisRun,
					);
					extraHotModules = _internals.effectiveHotModules(
						[],
						sourceForThisRun,
					);
				} else {
					effectiveThreshold = _internals.effectiveActivationThreshold(
						staticActivationThreshold,
						currentCalibration,
					);
					extraHotModules = _internals.effectiveHotModules(
						[],
						currentCalibration,
					);
				}
			}
		} catch (err) {
			// Phase 16 (C1.H4): calibration silently degrading to static
			// thresholds is operator-visible — without this, p-threshold
			// gate decisions could be using stale knobs and the operator
			// wouldn't know calibration stopped updating.
			logger.criticalWarn(
				`[epic_decide_phase] calibration step failed, falling back to static knobs: ${err instanceof Error ? err.message : String(err)}`,
			);
			effectiveThreshold = staticActivationThreshold;
			extraHotModules = [];
		}
	}

	// Q1: per-plan activation — evaluate over the whole plan's task graph,
	// not just `phase`. The promote/demote decision applies plan-wide.
	const rawTasks: Array<{ id: string; files_touched?: string[] }> = [];
	for (const ph of plan.phases) {
		for (const task of ph.tasks) {
			rawTasks.push(task);
		}
	}
	const tasks: CouplingTask[] = rawTasks.map((task) => {
		const scopeFiles = declaredScopes[task.id] ?? [];
		const scope: string[] =
			scopeFiles.length > 0 ? scopeFiles : (task.files_touched ?? []);
		return { id: task.id, scope };
	});

	// Co-change signal: fetched ONLY when `turbo.epic.cochange.enabled ===
	// true`. Disabled ⇒ no git-log scan, `p` is computed from declared-path
	// conflicts alone, and the rationale records `disabled-by-config` —
	// distinct from an enabled signal that simply found no pairs.
	const { pairs, commitsObserved } = cochangeEnabled
		? await _internals.getCoChangeData(directory)
		: { pairs: [], commitsObserved: 0 };

	// Rule 1 of the greenfield-smart redesign: explicitly tell the activation
	// decider whether the project is a git repo. When it isn't, the greenfield
	// gate's premise (co-change history) does not apply, so the gate is
	// bypassed rather than fail-closed. See `decideEpicActivation`'s
	// `isGitProject` option for the full rationale.
	const isGitProject = (() => {
		try {
			return _internals.isGitRepo(directory);
		} catch {
			return false;
		}
	})();

	// Phase 10: compute cross-phase upstream task IDs for the phase being
	// decided. The activation gate then verifies each is in git history —
	// the predecessor-evidence check that replaces the legacy
	// `commitsObserved >= minCommitsForSignal` floor. See
	// `decideEpicActivation` for the rationale.
	const taskPhase = new Map<string, number>();
	for (const ph of plan.phases) {
		for (const task of ph.tasks) {
			taskPhase.set(task.id, ph.id);
		}
	}
	// Phase 14 (B29): filter to PENDING tasks only. A completed task
	// whose `depends:` field still contains an uncorrected phantom (the
	// architect typo'd, the task got finished anyway, the typo never got
	// removed) would otherwise keep the activation gate failing for
	// every future phase decision. The dep is no longer load-bearing
	// because the task is already done; we should not penalize future
	// phases for a stale declaration on a settled task.
	const currentPhaseTasks = (
		plan.phases.find((p) => p.id === phase)?.tasks ?? []
	).filter((t) => t.status !== 'completed');
	const crossPhaseUpstreamsSet = new Set<string>();
	const phantomDepsSet = new Set<string>();
	for (const task of currentPhaseTasks) {
		for (const dep of task.depends ?? []) {
			const depPhase = taskPhase.get(dep);
			if (depPhase === undefined) {
				// Phase 13 (B20): the architect typed a dep ID that
				// doesn't resolve to ANY task in the plan — usually an LLM
				// typo ("1.7" instead of "1.4"). The original Phase 12
				// fix lumped these into `crossPhaseUpstreams`, which made
				// the rationale claim a missing CROSS-PHASE upstream
				// even when the typo was for an intra-phase dep —
				// sending the architect off to commit a phantom. Track
				// them separately so the rationale surfaces a dedicated
				// "phantom dep id" reason that points at the actual fix
				// (correct the declaration), not a false "wait for the
				// upstream to commit".
				phantomDepsSet.add(dep);
				continue;
			}
			if (depPhase < phase) {
				crossPhaseUpstreamsSet.add(dep);
			}
		}
	}
	if (phantomDepsSet.size > 0) {
		// Phase 15 (B34): elevated to criticalWarn so the architect-typo
		// signal reaches the operator's logs during a live benchmark.
		// Phantom deps fail the gate closed (Phase 13 B20); without this
		// the architect sees a demote with no immediate diagnostic.
		logger.criticalWarn(
			`[epic_decide_phase] phase ${phase} has dep IDs that don't resolve to any task in the plan (probable architect typo): ${[...phantomDepsSet].join(', ')}. Fix the dep declaration; the gate fails closed until the IDs are corrected.`,
		);
	}
	const crossPhaseUpstreams = [...crossPhaseUpstreamsSet];
	const phantomDeps = [...phantomDepsSet];
	// Phase 12 (B10): use the status-bearing variant so we can fail
	// CLOSED if the git-log read itself broke. The Phase 10 gate is now
	// the ONLY safety signal (the commit-count floor was retired) — if
	// the predicate degrades to permissive (`() => true`) on git failure
	// the way the lane planner's Rule 3 does, the gate would silently
	// admit unverified parallelism. Instead: on git failure substitute a
	// fail-closed predicate (`() => false`) so the rationale lists every
	// upstream as missing and the architect can see the broken state.
	let isUpstreamCommitted: ((taskId: string) => boolean) | undefined;
	if (isGitProject) {
		// Plan-scoped markers (Epic v2 C0): only this plan's markers count.
		const evidence = await _internals.buildIsUpstreamCommittedWithStatus(
			directory,
			plan,
		);
		isUpstreamCommitted = evidence.gitFailed ? () => false : evidence.predicate;
	}

	const verdict = _internals.decideEpicActivation(
		tasks,
		pairs,
		commitsObserved,
		{
			activationThreshold: effectiveThreshold,
			minCommitsForSignal,
			cochangeNpmiThreshold,
			cochangeMinCoChanges,
			extraHotModules,
			isGitProject,
			crossPhaseUpstreams,
			phantomDeps,
			isUpstreamCommitted,
			cochangeSignal: cochangeEnabled ? 'enabled' : 'disabled-by-config',
		},
	);

	// Best-effort persist of the decision rationale. Evidence-write failure
	// alone is an audit-trail miss, not a safety issue — log and continue.
	try {
		_internals.appendPromotionEvidence(directory, {
			timestamp: new Date().toISOString(),
			sessionID,
			phase,
			verdict,
		});
	} catch (err) {
		logger.warn(
			`[epic_decide_phase] promotion-evidence append failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// Mirror the decision into the open epic's record so `/swarm epic status`
	// can show the most recent rationale. Unlike the evidence write above, a
	// failure here means the durable lifecycle state is broken — fail closed
	// and refuse to dispatch rather than executing without reliable state.
	try {
		_internals.recordEpicLastDecision(
			directory,
			epic.epicKey,
			{
				decidedAt: new Date().toISOString(),
				phase,
				decision: verdict.decision,
				p: verdict.p,
				blockingReasons: verdict.blockingReasons,
			},
			epic.token,
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error(
			`[epic_decide_phase] recordEpicLastDecision failed, refusing to dispatch: ${msg}`,
		);
		return {
			success: false,
			verdict,
			reason: 'epic-state-unreadable',
			errors: [msg],
		};
	}

	// Decide-only: return the verdict so the architect can call
	// `epic_plan_waves` and dispatch each wave via Task for full CLI
	// visibility.
	return {
		success: true,
		verdict,
		reason: verdict.decision === 'demote' ? 'demoted' : 'decided',
	};
}

/**
 * Transparent decide-only tool. Returns the verdict (promote/demote/error)
 * without dispatching coders. The architect should:
 *  1. Call this after declaring scopes for all pending tasks.
 *  2. Surface the verdict to the user.
 *  3. If verdict is `promote`, call `epic_plan_waves` to get the wave plan,
 *     then for each wave dispatch one `Task` per `taskId` in that wave —
 *     ALL in one assistant message so the wave runs concurrently. Wait for
 *     the wave to complete, then advance. Each Task is a visible subagent
 *     the user can click into for live progress.
 *  4. After each task completes (via `update_task_status`), call
 *     `epic_record_divergence` to feed the calibration loop.
 *
 * This is the only Epic dispatch flow: every concurrent coder is a visible
 * Task subagent (there is no opaque decide-and-dispatch tool).
 */
export const epic_decide_phase: ToolDefinition = createSwarmTool({
	allowWorkingDirectoryOverride: true,
	description:
		"Compute the Epic Mode verdict for a phase. Runs a scope-graph preflight, rolls the calibration loop forward over any new divergence records, computes the plan-wide coupling coefficient `p`, gates on three checks (p-threshold, hot-module, greenfield), persists the decision to .swarm/evidence/epic-promotions.jsonl, and returns the verdict (promote/demote/error). This tool does NOT dispatch coders; on a `promote` verdict the architect pairs it with `epic_plan_waves` to obtain the wave plan, then for each wave issues one `Task(subagent_type='coder', ...)` per taskId — all in one assistant message — so each concurrent coder appears as a visible subagent. On a `demote` verdict the architect falls back to per-task serial. Requires `turbo.epic.mode.enabled: true` in config (else reason `epic-disabled-by-config`) and an epic open for the current plan via `/swarm epic start` (else `epic-mode-not-active`). A `scopes-missing` reason means a pending task's declared scope is undeclared, expired (bindings live 1h), or was declared against an older plan revision — re-run `declare_scope` for each listed task.",
	args: {
		directory: z.string().describe('Project root directory'),
		phase: z.number().int().positive().describe('Phase number to decide on'),
		sessionID: z.string().describe('Active session ID'),
	},
	execute: async (args: unknown, _directory: string, ctx) => {
		const { phase, sessionID: argSessionID } = args as EpicRunPhaseArgs;
		const sessionID =
			ctx?.sessionID && ctx.sessionID.length > 0 ? ctx.sessionID : argSessionID;
		// This is the `epic_decide_phase` tool. When ctx carries no session id we
		// fall back to the model-supplied argument, which is `z.string()`.
		//
		// What this guard does NOT do: protect lane provisioning.
		// `executeEpicDecidePhase` uses `sessionID` only as the evidence
		// record's session field and never reaches `provisionWorktree`. The
		// lane-provisioning guard lives in `provisionWorktree` itself.
		//
		// What it DOES do: turn an unencodable session id into a precise error
		// instead of recording a bogus session id in the evidence log.
		if (!isSwarmSessionId(sessionID)) {
			return JSON.stringify(
				{
					ok: false,
					error: `Invalid sessionID "${sessionID}". It must look like "ses_" followed by letters/digits. Omit the argument so the tool can use the active session id.`,
				},
				null,
				2,
			);
		}
		const result = await executeEpicDecidePhase({
			phase,
			sessionID,
			directory: _directory,
		});
		return JSON.stringify(result, null, 2);
	},
});
