/**
 * `/swarm epic start` orchestration (Epic v2 C1a).
 *
 * Refusals, checked in this order (the first one wins):
 *   1. epic-disabled-by-config   `turbo.epic.mode.enabled !== true` (fail closed)
 *   2. no-plan / plan-ledger-unreadable
 *   3. epic-already-open (same plan ⇒ idempotent success) /
 *      epic-open-for-other-plan / epic-state-unreadable
 *   4. turbo-active               config `turbo_mode: true`, any in-memory
 *                                 session with Turbo on, or a running durable
 *                                 Lean run (read without migrating Lean state)
 *   5. dirty-baseline             git only: changes outside `.swarm/`
 *      detached-head              git + epic-branch policy: HEAD is detached
 *                                 (or the branch has no commit yet)
 *      epic-branch-exists         git + epic-branch policy:
 *                                 `swarm/epic/<epicKey>` already exists (left
 *                                 by an earlier, abandoned epic of this plan)
 *   6. in-flight-coders           project-wide (see `findInFlightCoderWork`)
 *   7. not-epic-sized             sizing verdict (`--force` overrides; recorded)
 *   8. branch-create-failed       `git checkout -b` failed after the row was
 *                                 created — row and sentinel rolled back
 *
 * Commit policy (`turbo.epic.commit_policy`, default `epic-branch`): after
 * the CAS create a git epic checks out `swarm/epic/<epicKey>` and records it
 * (`git.epicBranch`) only once the checkout succeeded (M-e). Non-git
 * projects (always `current-branch`) may open an epic but run it serially
 * (maxParallel 1, M-i).
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	isTerminalDelegationStatus,
	readDelegationsDetailed,
} from '../../background/pending-delegations.js';
import { DEFAULT_LEAN_TURBO_CONFIG } from '../../config/constants.js';
import { loadPluginConfigWithMeta } from '../../config/index.js';
import type { Plan } from '../../config/plan-schema.js';
import type { PluginConfig } from '../../config/schema.js';
import { listCoordinationStates } from '../../db/coordination-store.js';
import { projectDbExists } from '../../db/project-db.js';
import { _internals as gitBranchInternals } from '../../git/branch.js';
import {
	awaitingMergeByCallID,
	standardWorktreeByCallID,
} from '../../hooks/delegation-gate/worktree-isolation.js';
import { scanWorktreeProvisioningOwnersForRecovery } from '../../hooks/delegation-gate/worktree-provisioning-owner.js';
import { scanWorktreeRecoveryAuthoritiesForRecovery } from '../../hooks/delegation-gate/worktree-recovery-authority.js';
import {
	computePlanStructureHash,
	readPlanEpochIdentity,
} from '../../plan/ledger.js';
import { loadPlanJsonOnly } from '../../plan/manager.js';
import { hasActiveTurboMode } from '../../state.js';
import { withTimeout } from '../../utils/timeout.js';
import { listCoderSettlementWalStates } from '../../workflow/coder-settlement.js';
import { listRecoveryRecords, recoveryReadErrored } from '../lean/recovery.js';
import {
	EPIC_MODE_CONFIG_DISABLED_MESSAGE,
	isEpicModeConfigEnabled,
} from './config-gate.js';
import { resolveEpicDeclaredScopes } from './declared-scopes.js';
import {
	checkoutNewEpicBranch,
	epicBranchName,
	listDirtyPathsOutsideSwarm,
	localBranchExists,
	readCurrentBranch,
	resolveEpicCommitPolicy,
	undoEpicBranchCreate,
} from './epic-branch.js';
import {
	computeEpicKey,
	createEpicRecord,
	deleteEpicState,
	type EpicRecordV1,
	inspectEpic,
	planIdentityOf,
	readLedgerRootDigest,
	recordEpicBranch,
} from './lifecycle.js';
import { computePlanKey, PLAN_SCOPE_RESOLVE_TIMEOUT_MS } from './plan-key.js';
import {
	type EpicSizingVerdict,
	evaluateEpicSizing,
	resolveEpicSizingThresholds,
} from './sizing.js';
import { planEpicWaves } from './wave-planner.js';

export type EpicStartRefusal =
	| 'epic-disabled-by-config'
	| 'no-plan'
	| 'plan-ledger-unreadable'
	| 'epic-open-for-other-plan'
	| 'epic-state-unreadable'
	| 'turbo-active'
	| 'dirty-baseline'
	| 'detached-head'
	| 'epic-branch-exists'
	| 'in-flight-coders'
	| 'not-epic-sized'
	| 'branch-create-failed';

export type EpicStartResult =
	| { status: 'started'; record: EpicRecordV1 }
	| { status: 'already-open'; record: EpicRecordV1 }
	| {
			status: 'refused';
			reason: EpicStartRefusal;
			details: string[];
			sizing?: EpicSizingVerdict;
	  };

export interface EpicStartOptions {
	directory: string;
	sessionID: string;
	force: boolean;
}

const LEAN_SESSION_NAMESPACE = 'turbo.lean.session';
const BACKGROUND_DELEGATION_NAMESPACE = 'background.pending-delegation';
const LEGACY_LEAN_STATE_FILE = 'turbo-state.json';
const MAX_LEGACY_LEAN_STATE_BYTES = 4 * 1024 * 1024;
/** Non-terminal coder settlement WAL states (same as assertNoUnsettledCoderDispatch). */
const UNSETTLED_WAL_STATES = new Set(['DISPATCHED', 'PREPARED', 'unreadable']);

function refused(
	reason: EpicStartRefusal,
	details: string[],
	sizing?: EpicSizingVerdict,
): EpicStartResult {
	return { status: 'refused', reason, details, sizing };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Durable Lean run marked `running` — read without the migrating Lean reader. */
function findRunningLeanRun(directory: string): string | null {
	if (projectDbExists(directory)) {
		const rows = listCoordinationStates(directory, LEAN_SESSION_NAMESPACE);
		const running = rows.find((row) => row.status === 'running');
		if (running)
			return `durable Lean Turbo run for session ${running.entityKey}`;
		if (rows.length > 0) return null;
	}
	const legacyPath = path.join(directory, '.swarm', LEGACY_LEAN_STATE_FILE);
	try {
		const stat = fs.statSync(legacyPath);
		if (!stat.isFile() || stat.size > MAX_LEGACY_LEAN_STATE_BYTES) return null;
		const parsed = JSON.parse(fs.readFileSync(legacyPath, 'utf-8')) as {
			sessions?: Record<string, { status?: unknown }>;
		};
		for (const [sessionID, state] of Object.entries(parsed.sessions ?? {})) {
			if (state?.status === 'running') {
				return `durable Lean Turbo run for session ${sessionID} (.swarm/${LEGACY_LEAN_STATE_FILE})`;
			}
		}
	} catch {
		// absent / unreadable legacy projection ⇒ no evidence of a running run
	}
	return null;
}

/** Why Turbo blocks the start, or null (M-a). */
export function findTurboActivity(
	directory: string,
	config: Pick<PluginConfig, 'turbo_mode'>,
): string[] {
	const reasons: string[] = [];
	if (config.turbo_mode === true) {
		reasons.push(
			'config `turbo_mode: true` seeds Turbo into every new session — set it to false',
		);
	}
	if (_internals.hasActiveTurboMode()) {
		reasons.push(
			'a session in this process has Turbo on — run `/swarm turbo off` in it',
		);
	}
	const lean = _internals.findRunningLeanRun(directory);
	if (lean) reasons.push(`${lean} — finish it or run \`/swarm turbo off\``);
	return reasons;
}

/** Changes outside `.swarm/` (git only). Throws when git fails. */
export function findDirtyBaseline(directory: string): string[] {
	return listDirtyPathsOutsideSwarm(directory, _internals.gitExec);
}

/**
 * Project-wide in-flight coder work (MINOR 2), read-only:
 *  - tracked standard worktree dispatches / lanes awaiting merge-back
 *    (in-memory, this process);
 *  - non-terminal durable background delegations;
 *  - unsettled coder settlement WALs (DISPATCHED / PREPARED / unreadable);
 *  - preserved Lean recovery lanes, preserved/claimed worktree recovery
 *    authorities, and lanes being provisioned.
 * Uncertain stores fail closed (reported as in flight).
 */
export async function findInFlightCoderWork(
	directory: string,
): Promise<string[]> {
	const found: string[] = [];
	const dispatches = _internals.countTrackedWorktreeDispatches();
	if (dispatches > 0) {
		found.push(
			`${dispatches} worktree-isolated coder dispatch(es) running or awaiting merge-back — let them finish (\`/swarm lanes\` shows them)`,
		);
	}

	if (projectDbExists(directory)) {
		const rows = listCoordinationStates(
			directory,
			BACKGROUND_DELEGATION_NAMESPACE,
		);
		const open = rows.filter(
			(row) =>
				!isTerminalDelegationStatus(
					row.status as Parameters<typeof isTerminalDelegationStatus>[0],
				),
		);
		if (open.length > 0) {
			found.push(
				`${open.length} non-terminal background delegation(s) — let them finish`,
			);
		}
	} else {
		const outcome = _internals.readDelegationsDetailed(directory);
		if (outcome.status !== 'ok') {
			found.push(
				'background delegation state is uncertain — cannot prove no coder is running',
			);
		} else {
			const open = outcome.records.filter(
				(record) => !isTerminalDelegationStatus(record.status),
			);
			if (open.length > 0) {
				found.push(
					`${open.length} non-terminal background delegation(s) — let them finish`,
				);
			}
		}
	}

	const wal = await _internals.listCoderSettlementWalStates(directory);
	const unsettled = wal.states.filter((state) =>
		UNSETTLED_WAL_STATES.has(state.state),
	);
	// A settlement whose owner is alive (this process or a live foreign pid)
	// is a coder still running; a stale one (owner gone) or an unreadable WAL
	// would wedge that task's next dispatch — both block, with their remedy.
	const live = unsettled.filter(
		(state) =>
			state.state !== 'unreadable' &&
			(state.ownedInProcess || state.ownedByLiveForeignPid),
	);
	const stale = unsettled.filter((state) => !live.includes(state));
	const describe = (states: typeof unsettled) =>
		states
			.slice(0, 5)
			.map((state) => `${state.taskId} (${state.state})`)
			.join(', ');
	if (live.length > 0) {
		found.push(
			`${live.length} coder settlement(s) still owned by a running dispatch: ${describe(live)} — let them finish`,
		);
	}
	if (stale.length > 0) {
		found.push(
			`${stale.length} stale or unreadable coder settlement(s): ${describe(stale)} — run \`/swarm recover <taskId>\` for each (it settles WALs whose owner process is gone)`,
		);
	}
	if (wal.truncated) {
		found.push(
			'coder settlement directory exceeds the scan bound — cannot prove every settlement is final; run `/swarm recover` to settle stale WALs',
		);
	}

	const recovery = _internals.listRecoveryRecords(directory);
	if (recovery.length > 0) {
		found.push(
			`${recovery.length} preserved Lean recovery lane(s) in .swarm/recovery/ — finish them with Lean Turbo (\`/swarm turbo lean on\`, then \`/swarm turbo off\`) or discard those lanes`,
		);
	} else if (_internals.recoveryReadErrored(directory)) {
		found.push(
			'Lean recovery records in .swarm/recovery/ are unreadable — inspect and repair or remove them',
		);
	}

	const authorities =
		_internals.scanWorktreeRecoveryAuthoritiesForRecovery(directory);
	if (authorities.status === 'ok') {
		const liveLanes = authorities.authorities.filter(
			(authority) =>
				authority.status === 'preserved' || authority.status === 'claimed',
		);
		if (liveLanes.length > 0) {
			found.push(
				`${liveLanes.length} preserved/claimed worktree recovery lane(s) — inspect with \`/swarm lanes\`; merge or discard them (\`/swarm reset-session\` can purge dirty lanes)`,
			);
		}
	} else {
		found.push(
			`worktree recovery state is ${authorities.status} — inspect .swarm/worktree-merge-recovery-v2.json`,
		);
	}

	const owners =
		_internals.scanWorktreeProvisioningOwnersForRecovery(directory);
	if (owners.status === 'ok') {
		if (owners.owners.length > 0) {
			found.push(
				`${owners.owners.length} worktree lane(s) being provisioned — let the dispatch finish (\`/swarm lanes\`)`,
			);
		}
	} else {
		found.push(`worktree provisioning state is uncertain (${owners.reason})`);
	}
	return found;
}

function isPending(status: string | undefined): boolean {
	return status !== 'completed' && status !== 'closed';
}

/**
 * Sizing inputs from the plan: pending tasks, scoped tasks, and the serial
 * step count of a wave-planner dry run (every phase, under `maxParallel`,
 * over the estimated scopes). Cross-phase dependencies count as satisfied
 * (phases run in order).
 */
export function computeEpicSizing(
	directory: string,
	plan: Plan,
	config: PluginConfig,
	maxParallel: number,
): EpicSizingVerdict {
	const pendingIds: string[] = [];
	for (const phase of plan.phases) {
		for (const task of phase.tasks ?? []) {
			if (isPending(task.status)) pendingIds.push(task.id);
		}
	}
	const declared = _internals.resolveEpicDeclaredScopes(
		directory,
		plan,
		pendingIds,
	);
	// Estimated scope: the live declared scope, else `files_touched`
	// (declarations are per phase and expire, so most tasks are estimated
	// from the plan at start time). Passed explicitly to the planner so
	// `require_declared_scope` does not serialize an estimated task.
	const scopes: Record<string, string[]> = Object.create(null);
	let scoped = 0;
	for (const phase of plan.phases) {
		for (const task of phase.tasks ?? []) {
			if (!isPending(task.status)) continue;
			const live = declared[task.id] ?? [];
			scopes[task.id] = live.length > 0 ? live : (task.files_touched ?? []);
			if (scopes[task.id].length > 0) scoped += 1;
		}
	}
	// Preview copy: closed tasks behave as resolved for dependency purposes.
	const preview = {
		phases: plan.phases.map((phase) => ({
			...phase,
			tasks: (phase.tasks ?? []).map((task) =>
				task.status === 'closed'
					? { ...task, status: 'completed' as const }
					: task,
			),
		})),
	};
	const leanConfig = {
		...DEFAULT_LEAN_TURBO_CONFIG,
		...(config.turbo?.lean ?? {}),
		max_parallel_coders: maxParallel,
	};
	let serialSteps = 0;
	for (const phase of preview.phases) {
		if (!phase.tasks.some((task) => isPending(task.status))) continue;
		const waves = planEpicWaves(
			directory,
			phase.id,
			preview as Parameters<typeof planEpicWaves>[2],
			leanConfig,
			scopes,
			() => true,
		);
		serialSteps +=
			waves.waves.length +
			waves.serializedTasks.length +
			waves.degradedTasks.length;
	}
	return evaluateEpicSizing(
		{ pendingTasks: pendingIds.length, scopedTasks: scoped, serialSteps },
		resolveEpicSizingThresholds(config.turbo?.epic?.sizing),
	);
}

function readGitFacts(directory: string): EpicRecordV1['git'] {
	if (!_internals.getGitRepositoryStatus(directory).isRepo) {
		return {
			isRepo: false,
			baseCommit: null,
			originalBranch: null,
			epicBranch: null,
		};
	}
	let baseCommit: string | null = null;
	let originalBranch: string | null = null;
	try {
		baseCommit = _internals.gitExec(['rev-parse', 'HEAD'], directory).trim();
	} catch {
		baseCommit = null; // unborn branch
	}
	try {
		originalBranch = _internals
			.gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], directory)
			.trim();
	} catch {
		originalBranch = null;
	}
	// `rev-parse --abbrev-ref` prints the literal `HEAD` when detached.
	if (originalBranch === 'HEAD' || originalBranch === '') originalBranch = null;
	return { isRepo: true, baseCommit, originalBranch, epicBranch: null };
}

export async function startEpic(
	options: EpicStartOptions,
): Promise<EpicStartResult> {
	const { directory, sessionID, force } = options;

	// 1. Config master gate.
	let config: PluginConfig;
	try {
		config = _internals.loadPluginConfigWithMeta(directory).config;
	} catch {
		return refused('epic-disabled-by-config', [
			EPIC_MODE_CONFIG_DISABLED_MESSAGE,
		]);
	}
	if (!isEpicModeConfigEnabled(config)) {
		return refused('epic-disabled-by-config', [
			EPIC_MODE_CONFIG_DISABLED_MESSAGE,
		]);
	}

	// 2. Plan + ledger identity.
	let plan: Plan | null;
	try {
		plan = await _internals.loadPlanJsonOnly(directory);
	} catch (error) {
		return refused('no-plan', [
			`plan could not be loaded: ${errorText(error)}`,
		]);
	}
	if (!plan) {
		return refused('no-plan', [
			'No plan found at `.swarm/plan.json` — create and approve a plan first.',
		]);
	}
	let planEpoch: string | null;
	let planIdentityHashFromLedger: string | null;
	try {
		const identity = await withTimeout(
			_internals.readPlanEpochIdentity(directory, plan),
			PLAN_SCOPE_RESOLVE_TIMEOUT_MS,
			new Error(
				`plan ledger read timed out after ${PLAN_SCOPE_RESOLVE_TIMEOUT_MS}ms`,
			),
		);
		planEpoch = identity?.planEpoch ?? null;
		planIdentityHashFromLedger = identity?.planIdentityHash ?? null;
	} catch (error) {
		return refused('plan-ledger-unreadable', [errorText(error)]);
	}
	// The epic binds to the plan ledger's root (and its epoch). Without a
	// ledger — or with a legacy ledger that has not adopted an epoch yet —
	// the next save/completion re-roots or adopts, which would orphan the
	// epic (or change its plan key) right after it opened.
	const ledgerRootDigest = readLedgerRootDigest(directory);
	if (
		planEpoch === null ||
		ledgerRootDigest === null ||
		ledgerRootDigest === 'unreadable'
	) {
		return refused('plan-ledger-unreadable', [
			ledgerRootDigest === 'unreadable'
				? 'The plan ledger (.swarm/plan-ledger.jsonl) could not be read.'
				: 'The plan has no plan ledger with a plan epoch yet.',
			'Save the plan first (save_plan) so the plan ledger exists, then retry `/swarm epic start`.',
		]);
	}
	const identity = planIdentityOf(plan);
	const planKey = computePlanKey(
		planIdentityHashFromLedger ?? identity.planIdentityHash,
		planEpoch,
	);
	const epicKey = computeEpicKey(identity.planId, planKey);

	// 3. Existing epic.
	const inspection = _internals.inspectEpic(directory, plan);
	if (inspection.unreadable) {
		return refused('epic-state-unreadable', [
			inspection.unreadable,
			'Run `/swarm epic status` to diagnose or `/swarm epic close --abandon` to repair.',
		]);
	}
	if (inspection.record) {
		const existing = inspection.record;
		if (
			existing.epicKey === epicKey &&
			existing.status === 'open' &&
			inspection.orphanReason === null
		) {
			return { status: 'already-open', record: existing };
		}
		return refused('epic-open-for-other-plan', [
			`Epic ${existing.epicKey} (plan ${existing.planId}) is ${existing.status}${inspection.orphanReason ? ` and orphaned (${inspection.orphanReason})` : ''}.`,
			'Close it first: `/swarm epic close` (or `/swarm epic close --abandon`).',
		]);
	}

	// 4. Turbo must not be active (M-a).
	let turbo: string[];
	try {
		turbo = findTurboActivity(directory, config);
	} catch (error) {
		turbo = [`Turbo state could not be verified: ${errorText(error)}`];
	}
	if (turbo.length > 0) return refused('turbo-active', turbo);

	// 5. Clean baseline (git only).
	const git = readGitFacts(directory);
	const commitPolicy = git.isRepo
		? resolveEpicCommitPolicy(config)
		: 'current-branch';
	let epicBranch: string | null = null;
	if (git.isRepo) {
		let dirty: string[];
		try {
			dirty = findDirtyBaseline(directory);
		} catch (error) {
			return refused('dirty-baseline', [
				`git status failed: ${errorText(error)}`,
			]);
		}
		if (dirty.length > 0) {
			return refused('dirty-baseline', [
				`${dirty.length} uncommitted change(s) outside .swarm/: ${dirty.slice(0, 10).join(', ')}${dirty.length > 10 ? ', …' : ''}`,
				'Commit or stash them, then retry.',
			]);
		}
		if (commitPolicy === 'epic-branch') {
			if (git.originalBranch === null || git.baseCommit === null) {
				return refused('detached-head', [
					git.baseCommit === null
						? 'The current branch has no commit yet, so there is nothing to branch the epic from.'
						: 'HEAD is detached, so there is no branch to land the epic back onto at close.',
					'Check out (or create) a branch with at least one commit, then retry — or set `turbo.epic.commit_policy: "current-branch"`.',
				]);
			}
			epicBranch = epicBranchName(epicKey);
			let exists: boolean;
			try {
				exists = _internals.localBranchExists(directory, epicBranch);
			} catch (error) {
				return refused('branch-create-failed', [
					`git could not check for the epic branch \`${epicBranch}\`: ${errorText(error)}`,
				]);
			}
			if (exists) {
				return refused('epic-branch-exists', [
					`The epic branch \`${epicBranch}\` already exists (left by an earlier epic of this plan that was abandoned or not landed).`,
					`Land or inspect what you need from it, delete it with \`git branch -D ${epicBranch}\`, then retry.`,
				]);
			}
		}
	}

	// 6. No coder work in flight anywhere in the project.
	let inFlight: string[];
	try {
		inFlight = await findInFlightCoderWork(directory);
	} catch (error) {
		inFlight = [
			`in-flight coder state could not be verified: ${errorText(error)}`,
		];
	}
	if (inFlight.length > 0) return refused('in-flight-coders', inFlight);

	// 7. Sizing.
	const maxParallel = git.isRepo
		? Math.max(
				1,
				config.turbo?.lean?.max_parallel_coders ??
					DEFAULT_LEAN_TURBO_CONFIG.max_parallel_coders,
			)
		: 1;
	const sizing = computeEpicSizing(directory, plan, config, maxParallel);
	if (sizing.pendingTasks === 0) {
		// Nothing to run: --force cannot open an empty epic.
		return refused(
			'not-epic-sized',
			['Every task is already completed or closed — there is nothing to run.'],
			sizing,
		);
	}
	if (!sizing.epicSized && !force) {
		return refused('not-epic-sized', [], sizing);
	}

	const record: EpicRecordV1 = {
		schema: 'epic-record-v1',
		epicKey,
		token: _internals.newToken(),
		planId: identity.planId,
		planIdentityHash: identity.planIdentityHash,
		planEpoch,
		planKey,
		ledgerRootDigest,
		status: 'open',
		startedAt: new Date(_internals.now()).toISOString(),
		startedBySession: sessionID,
		forced: !sizing.epicSized,
		structureHashAtStart: computePlanStructureHash(plan),
		config: {
			commitPolicy,
			isolation: git.isRepo ? 'worktree' : 'main-tree-nogit',
			maxParallel,
		},
		git,
		sizing,
		lastDecision: null,
		closing: null,
	};
	const created = _internals.createEpicRecord(directory, record);
	if (created.outcome !== 'created') {
		// Lost the CAS race to a concurrent start.
		const winner = _internals.inspectEpic(directory, plan).record;
		if (winner && winner.epicKey === epicKey && winner.status === 'open') {
			return { status: 'already-open', record: winner };
		}
		return refused('epic-open-for-other-plan', [
			`Another epic was opened concurrently (${created.existingKeys.join(', ')}).`,
		]);
	}
	if (epicBranch === null || git.originalBranch === null) {
		return { status: 'started', record: created.record };
	}
	return switchToEpicBranch(
		directory,
		created.record,
		git.originalBranch,
		epicBranch,
	);
}

/**
 * Epic-branch policy, after the CAS create: `git checkout -b` the epic
 * branch (one attempt, no transient retry), then record it (M-e — never
 * before HEAD is verified on it). A `checkout -b` that reports failure is
 * judged by the ACTUAL state: when HEAD is on the epic branch anyway (for
 * example a post-checkout hook exited non-zero after the switch, or the
 * command timed out after switching) the start proceeds — `checkout -b`
 * from HEAD changes no files, only the ref. Otherwise, and on a record
 * failure, the start is rolled back: the branch is undone when it still
 * points at the start commit (HEAD switched back first), and the row +
 * sentinel are compare-and-deleted on this start's token.
 */
function switchToEpicBranch(
	directory: string,
	record: EpicRecordV1,
	originalBranch: string,
	epicBranch: string,
): EpicStartResult {
	const baseCommit = record.git.baseCommit ?? '';
	const rollbackState = (): string[] => {
		try {
			_internals.deleteEpicState(directory, record.epicKey, record.token);
			return [];
		} catch (error) {
			return [
				`rolling back the epic record failed: ${errorText(error)} — run \`/swarm epic close --abandon\``,
			];
		}
	};
	let checkoutError: string | null = null;
	try {
		_internals.checkoutNewEpicBranch(directory, epicBranch);
	} catch (error) {
		checkoutError = errorText(error);
	}
	if (checkoutError !== null) {
		let current: string | null = null;
		try {
			current = _internals.readCurrentBranch(directory);
		} catch {
			current = null;
		}
		if (current !== epicBranch) {
			return refused('branch-create-failed', [
				`git checkout -b ${epicBranch} failed: ${checkoutError}`,
				..._internals.undoEpicBranchCreate(
					directory,
					originalBranch,
					epicBranch,
					baseCommit,
				),
				...rollbackState(),
				'The epic was not opened; fix the git problem and retry.',
			]);
		}
		// HEAD is on the new branch: the switch happened despite the error.
	}
	let updated: EpicRecordV1 | null = null;
	let updateError: string | null = null;
	try {
		updated = _internals.recordEpicBranch(
			directory,
			record.epicKey,
			record.token,
			epicBranch,
		);
	} catch (error) {
		updateError = errorText(error);
	}
	if (updated) return { status: 'started', record: updated };
	return refused('branch-create-failed', [
		`the epic branch \`${epicBranch}\` was created but could not be recorded${updateError ? `: ${updateError}` : ' (the epic row vanished)'}`,
		..._internals.undoEpicBranchCreate(
			directory,
			originalBranch,
			epicBranch,
			baseCommit,
		),
		...rollbackState(),
		'The epic was not opened; retry `/swarm epic start`.',
	]);
}

/**
 * DI seam (AGENTS.md invariant 7) — tests replace collaborators without
 * `mock.module`. Restore in `afterEach`.
 */
export const _internals = {
	loadPluginConfigWithMeta,
	loadPlanJsonOnly,
	readPlanEpochIdentity,
	inspectEpic,
	createEpicRecord,
	deleteEpicState,
	recordEpicBranch,
	localBranchExists,
	checkoutNewEpicBranch,
	readCurrentBranch,
	undoEpicBranchCreate,
	resolveEpicDeclaredScopes,
	hasActiveTurboMode: (): boolean => hasActiveTurboMode(),
	findRunningLeanRun,
	gitExec: (args: string[], cwd: string): string =>
		gitBranchInternals.gitExec(args, cwd),
	getGitRepositoryStatus: (cwd: string) =>
		gitBranchInternals.getGitRepositoryStatus(cwd),
	/** In-memory worktree dispatches (lazy: the maps live in an import cycle). */
	countTrackedWorktreeDispatches: (): number =>
		standardWorktreeByCallID.size + awaitingMergeByCallID.size,
	readDelegationsDetailed,
	listCoderSettlementWalStates,
	listRecoveryRecords,
	recoveryReadErrored,
	scanWorktreeRecoveryAuthoritiesForRecovery,
	scanWorktreeProvisioningOwnersForRecovery,
	now: (): number => Date.now(),
	newToken: (): string => randomUUID(),
};
