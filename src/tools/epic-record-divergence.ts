/**
 * Epic Mode divergence-record tool (Capability D — capture leg).
 *
 * After the architect marks a task `completed` via `update_task_status`, it
 * calls this tool with `{ directory, taskId, sessionID }`. The tool:
 *
 *   1. Reads the task's DECLARED scope: the files of the most recent
 *      `declare_scope` declaration binding for `(taskId, planId)` in the
 *      authoritative v2 scope-binding store, via the Epic-owned HISTORICAL
 *      reader `readLatestEpicDeclaredScopeForCalibration`
 *      (`src/turbo/epic/declared-scopes.ts`). The live scheduling
 *      reader cannot be used here: completing a phase's last task advances
 *      `current_phase` (changing the plan structure hash) and bindings
 *      expire after 1 h, so the live binding is routinely gone by the time
 *      divergence is recorded. The historical read is calibration-only and
 *      never grants write authority.
 *   2. Reads the ACTUAL files attributed to this exact task. Foreground
 *      coder writes are attributed by the guardrails write hook on the coder
 *      CHILD session (not the architect session this tool runs in); only
 *      background-completion ingestion copies attribution onto the parent.
 *      The tool therefore unions the task's attribution across the architect
 *      session AND every same-project session in `swarmState.agentSessions`
 *      (read-only — other sessions are never mutated), canonicalized
 *      repo-relative. Child sessions are not removed on `session.idle` /
 *      `session.deleted` (only `/swarm close`, the 2 h stale sweep, or a
 *      restart without a snapshot drop them), so attribution is normally
 *      present — but it CAN be missing. When no session holds a non-empty
 *      attribution for the task the tool returns `attribution-unavailable`
 *      and records NOTHING: an empty actual set would otherwise be recorded
 *      as a clean task (ratio 0), teaching calibration "clean" from absent
 *      data.
 *   3. Appends one record to `.swarm/epic/divergence.jsonl` via
 *      `recordTaskDivergence`. The calibration engine reads that file on the
 *      next `epic_decide_phase` invocation.
 *
 * Best-effort by design — failure to record divergence is logged but never
 * surfaces as a task-blocking error. Worst case: a single observation is
 * missed and the calibration loop sees one fewer data point.
 *
 * Composition contract: this tool does NOT modify `update_task_status` or
 * any maintainer file. The architect is instructed to call it via the
 * `EPIC_MODE_BANNER` system-enhancer injection. If the architect forgets,
 * the only effect is missing calibration signal — Epic Mode keeps working.
 */

import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { loadPlanJsonOnly as loadPlanJsonOnly_import } from '../plan/manager.js';
import { derivePlanId } from '../plan/utils.js';
import {
	type AgentSessionState,
	getAgentSession as getAgentSession_import,
	getModifiedFilesForTask as getModifiedFilesForTask_import,
	resetModifiedFilesForTask as resetModifiedFilesForTask_import,
	swarmState,
} from '../state.js';
import {
	EPIC_MODE_CONFIG_DISABLED_MESSAGE,
	isEpicModeConfigEnabledForDirectory as isEpicModeConfigEnabledForDirectory_import,
} from '../turbo/epic/config-gate.js';
import { readLatestEpicDeclaredScopeForCalibration as readLatestEpicDeclaredScopeForCalibration_import } from '../turbo/epic/declared-scopes.js';
import { recordTaskDivergence as recordTaskDivergence_import } from '../turbo/epic/divergence-recorder.js';
import { isEpicOpenForProject as isEpicOpenForProject_import } from '../turbo/epic/lifecycle.js';
import * as logger from '../utils/logger.js';
import { canonicalAttributionPath } from '../utils/path.js';
import { createSwarmTool } from './create-tool.js';

export interface EpicRecordDivergenceArgs {
	directory: string;
	taskId: string;
	sessionID: string;
}

export interface EpicRecordDivergenceResult {
	success: boolean;
	/**
	 * Either:
	 *  - `'recorded'` — a record was appended to divergence.jsonl.
	 *  - `'already-recorded'` — the latest record for this `(planId, taskId)`
	 *    already has the same declared/actual sets (a retried call); nothing
	 *    appended (idempotent). `summary` describes the existing record.
	 *  - `'epic-disabled-by-config'` — `turbo.epic.mode.enabled !== true`;
	 *    no-op (`message` carries the remediation).
	 *  - `'epic-mode-not-active'` — no epic is open for the current plan; no-op.
	 *  - `'no-scope'` — no `declare_scope` declaration recorded for this task
	 *    under the current plan id (could be a pure verification task that
	 *    bypassed `declare_scope`), or the plan could not be loaded. Skipped.
	 *  - `'no-session'` — no agent session for `sessionID`; skipped.
	 *  - `'attribution-unavailable'` — no session (architect or any
	 *    same-project child) holds a non-empty file attribution for the
	 *    task (child session swept / closed / lost on restart, or writes
	 *    attributed under a different task id). Nothing is recorded so
	 *    calibration never learns "clean" from absent data.
	 *  - `'persist-failed'` — write to JSONL failed (logged); skipped.
	 */
	reason: string;
	/** Remediation text for `epic-disabled-by-config`. */
	message?: string;
	/** When `reason === 'recorded'`, summarises the record without the full file lists. */
	summary?: {
		declaredCount: number;
		actualCount: number;
		undeclaredCount: number;
		unusedCount: number;
		divergenceRatio: number;
		isClean: boolean;
	};
}

/**
 * Test-only DI seam (AGENTS.md invariant 7). Mutating this object is
 * file-scoped and trivially restorable via afterEach, avoiding Bun's
 * cross-file `mock.module` leak.
 */
export const _internals = {
	isEpicModeConfigEnabledForDirectory:
		isEpicModeConfigEnabledForDirectory_import,
	isEpicOpenForProject: isEpicOpenForProject_import,
	getAgentSession: getAgentSession_import,
	getModifiedFilesForTask: getModifiedFilesForTask_import,
	resetModifiedFilesForTask: resetModifiedFilesForTask_import,
	readLatestEpicDeclaredScopeForCalibration:
		readLatestEpicDeclaredScopeForCalibration_import,
	listAgentSessions: (): Iterable<[string, AgentSessionState]> =>
		swarmState.agentSessions.entries(),
	loadPlanJsonOnly: loadPlanJsonOnly_import,
	recordTaskDivergence: recordTaskDivergence_import,
};

type LoadedPlan = Awaited<ReturnType<typeof _internals.loadPlanJsonOnly>>;

/**
 * Look up the phase number that contains the given task id in the loaded
 * plan. Returns `undefined` when the task isn't in any phase — divergence is
 * still recorded without it.
 */
function findPhaseForTask(
	plan: NonNullable<LoadedPlan>,
	taskId: string,
): number | undefined {
	for (const phase of plan.phases) {
		if (phase.tasks.some((t: { id: string }) => t.id === taskId)) {
			return phase.id;
		}
	}
	return undefined;
}

/**
 * Union the task's attributed files across the architect session and every
 * other session in the same project-identity class (mirrors
 * `hasForeignAttributionRecord` in `update-task-status.ts`: both keyed-and-
 * equal, or both key-less, so a key-less session never reads a cross-project
 * record). Read-only. Entries are re-canonicalized repo-relative against
 * `directory` (legacy snapshot entries may be raw); non-canonicalizable
 * entries drop. One malformed session entry skips only itself.
 */
function collectTaskAttribution(
	directory: string,
	architectSessionID: string,
	architectSession: AgentSessionState,
	taskId: string,
): string[] {
	const collected: string[] = [];
	const addFrom = (session: AgentSessionState): void => {
		try {
			collected.push(..._internals.getModifiedFilesForTask(session, taskId));
		} catch {
			// one malformed session must not abort the union
		}
	};
	addFrom(architectSession);
	const architectProject = architectSession.owningProjectKey ?? null;
	try {
		for (const [sessionId, session] of _internals.listAgentSessions()) {
			if (sessionId === architectSessionID || session === architectSession) {
				continue;
			}
			if (!session || !(session.modifiedFilesByTask instanceof Map)) continue;
			if ((session.owningProjectKey ?? null) !== architectProject) continue;
			addFrom(session);
		}
	} catch {
		// iteration failure: keep whatever was collected
	}
	const canonical = new Set<string>();
	for (const file of collected) {
		const normalized = canonicalAttributionPath(file, directory);
		if (normalized !== null) canonical.add(normalized);
	}
	return [...canonical].sort();
}

export async function executeEpicRecordDivergence(
	args: EpicRecordDivergenceArgs,
): Promise<EpicRecordDivergenceResult> {
	const { directory, taskId, sessionID } = args;

	// Config master gate, like every other Epic tool (fails closed).
	if (!_internals.isEpicModeConfigEnabledForDirectory(directory)) {
		return {
			success: true,
			reason: 'epic-disabled-by-config',
			message: EPIC_MODE_CONFIG_DISABLED_MESSAGE,
		};
	}

	if (!_internals.isEpicOpenForProject(directory)) {
		return { success: true, reason: 'epic-mode-not-active' };
	}

	const session = _internals.getAgentSession(sessionID);
	if (!session) {
		return { success: true, reason: 'no-session' };
	}

	try {
		let plan: LoadedPlan = null;
		try {
			plan = await _internals.loadPlanJsonOnly(directory);
		} catch {
			plan = null;
		}
		// Historical (calibration-only) read: the latest declaration for this
		// task under the current plan id, regardless of expiry or structure
		// hash — see the module header for why the live reader is wrong here.
		const declaredScope =
			plan === null
				? null
				: _internals.readLatestEpicDeclaredScopeForCalibration({
						directory,
						taskId,
						plan,
					});
		if (declaredScope === null) {
			// No declaration means the architect skipped declare_scope, the
			// plan is unreadable, or the task is a non-code phase. Record
			// nothing — calibration only learns from tasks with a declared
			// baseline.
			return { success: true, reason: 'no-scope' };
		}

		const actualFiles = collectTaskAttribution(
			directory,
			sessionID,
			session,
			taskId,
		);
		if (actualFiles.length === 0) {
			// Absent attribution is NOT evidence of a clean task. Recording an
			// empty actual set would yield ratio 0 / isClean and bias the
			// calibration loop toward promotion. Skip the observation.
			logger.warn(
				`[epic_record_divergence] no file attribution found for ${taskId} in any same-project session; skipping (calibration must not learn "clean" from absent data)`,
			);
			return { success: true, reason: 'attribution-unavailable' };
		}
		const phaseNumber =
			plan === null ? undefined : findPhaseForTask(plan, taskId);

		const result = _internals.recordTaskDivergence({
			directory,
			sessionID,
			taskId,
			planId: plan === null ? undefined : derivePlanId(plan),
			phaseNumber,
			declaredScope,
			actualFiles,
		});

		if (!result) {
			logger.warn(
				`[epic_record_divergence] persist failed for ${taskId}; calibration will miss one observation`,
			);
			return { success: true, reason: 'persist-failed' };
		}

		const { record } = result;
		return {
			success: true,
			reason: result.duplicate === true ? 'already-recorded' : 'recorded',
			summary: {
				declaredCount: record.declaredScope.length,
				actualCount: record.actualFiles.length,
				undeclaredCount: record.undeclared.length,
				unusedCount: record.unused.length,
				divergenceRatio: record.divergenceRatio,
				isClean: record.isClean,
			},
		};
	} finally {
		// Epic retains completed-task attribution until this calibration attempt,
		// then releases it regardless of the tool's best-effort outcome.
		_internals.resetModifiedFilesForTask(session, taskId, { remove: true });
	}
}

export const epic_record_divergence: ToolDefinition = createSwarmTool({
	allowWorkingDirectoryOverride: true,
	description:
		'Record divergence between a completed task\'s declared scope and the files actually modified, for Epic Mode calibration (Capability D). Call this immediately after update_task_status sets status="completed". Appends one line to .swarm/epic/divergence.jsonl (idempotent per task: an identical retry returns `already-recorded`; a rework supersedes the earlier record). Best-effort — never fails the calling agent. Use only while an epic is open for the current plan (`/swarm epic start`).',
	args: {
		directory: z.string().describe('Project root directory'),
		taskId: z.string().describe('Task id whose divergence should be recorded'),
		sessionID: z.string().describe('Active session ID'),
	},
	execute: async (args: unknown, _directory: string, ctx) => {
		const { taskId, sessionID: argSessionID } =
			args as EpicRecordDivergenceArgs;
		// Same rationale as epic_decide_phase: prefer the framework-supplied
		// session over a model-hallucinated value (the session keys the
		// architect's file attribution).
		const sessionID =
			ctx?.sessionID && ctx.sessionID.length > 0 ? ctx.sessionID : argSessionID;
		return JSON.stringify(
			await executeEpicRecordDivergence({
				directory: _directory,
				taskId,
				sessionID,
			}),
			null,
			2,
		);
	},
});
