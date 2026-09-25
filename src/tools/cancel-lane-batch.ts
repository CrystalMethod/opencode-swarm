/**
 * cancel_lane_batch — the ONLY model-facing destructive cancellation surface
 * for dispatch_lanes_async batches (issue #2971).
 *
 * `collect_lane_results` is observation-only; an ordinary collection call can
 * no longer abort or terminalize a lane. Cancellation is a distinct, explicit,
 * authorized workflow action:
 *
 *  - `confirm: true` (literal) + a bounded `reason` are required — the
 *    authorization boundary.
 *  - A fresh liveness snapshot gates every lane: `busy`/`retry` (live) and any
 *    unrecognized status type are REFUSED; a degraded/absent probe REFUSES the
 *    whole batch fail-closed (an observer failure never authorizes a
 *    destructive action); a session the host affirmatively does not know
 *    (absent from a successful status map, or `idle`) may be cancelled — this
 *    preserves the documented orphan-cleanup path.
 *  - Per lane: identity re-read → bounded abort (a timeout never claims
 *    cancellation) → post-abort re-read (a child that completed in the race
 *    window WINS and is never overwritten) → exactly-once terminal claim
 *    carrying `workflowLaneFailureClass: 'operator_cancelled'`, distinct from
 *    host `liveness`.
 *
 * A human force path for live lanes remains the restricted
 * `/swarm abort-pr-workflow` command; this tool never force-cancels live work.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { settleDelegationTerminal } from '../background/delegation-lifecycle';
import {
	findByBatchIdDetailed,
	findByCorrelationIdDetailed,
} from '../background/pending-delegations';
import { swarmState } from '../state';
import { stripControlCharacters } from '../utils/sanitize-display';
import { createSwarmTool } from './create-tool';
import type { SessionOps } from './dispatch-lanes';

const MAX_BATCH_ID_CHARS = 120;
const MAX_CANCEL_REASON_CHARS = 200;
/** One batched status probe per call, bounded like the collector's status slice. */
const CANCEL_PROBE_BUDGET_MS = 2_000;
/** Per-lane bounded abort; the overall deadline keeps a large batch bounded. */
const CANCEL_ABORT_BUDGET_MS = 2_000;
const CANCEL_TOTAL_BUDGET_MS = 30_000;

export const CancelLaneBatchArgsSchema = z
	.object({
		batch_id: z.string().min(1).max(MAX_BATCH_ID_CHARS),
		reason: z
			.string()
			.trim()
			.min(1)
			.max(MAX_CANCEL_REASON_CHARS)
			.describe(
				'Bounded operator reason recorded on every cancelled lane terminal',
			),
		confirm: z
			.literal(true)
			.describe(
				'Explicit confirmation: cancellation is destructive and authorized by the operator',
			),
		lanes: z
			.array(z.string().min(1).max(128))
			.max(64)
			.optional()
			.describe('Optional lane-id filter; default is every active lane'),
	})
	.strict();

export interface CancelLaneBatchRefusal {
	lane_id: string;
	host_status?: string;
	degraded_reason?: string;
	next_action: string;
}

export interface CancelLaneBatchResult {
	success: boolean;
	failure_class?:
		| 'invalid_args'
		| 'not_found'
		| 'no_client'
		| 'probe_degraded'
		| 'store_unreadable';
	message?: string;
	batch_id: string;
	total_active: number;
	cancelled: number;
	refused: CancelLaneBatchRefusal[];
	preserved_completions: string[];
	already_settled: string[];
	errors: string[];
}

export const _internals: {
	getSessionOps: () => SessionOps | null;
	now: () => number;
	probeBudgetMs: number;
	abortBudgetMs: number;
	totalBudgetMs: number;
} = {
	getSessionOps: () =>
		(swarmState.opencodeClient?.session as unknown as SessionOps | undefined) ??
		null,
	now: () => Date.now(),
	probeBudgetMs: CANCEL_PROBE_BUDGET_MS,
	abortBudgetMs: CANCEL_ABORT_BUDGET_MS,
	totalBudgetMs: CANCEL_TOTAL_BUDGET_MS,
};

const LIVE_NEXT_ACTION =
	'lane is live (busy/retry): wait for it to finish or poll again; live work can only be ended by the human force path (/swarm abort-pr-workflow)';
const DEGRADED_NEXT_ACTION =
	'observer degraded: poll again with collect_lane_results; an observer failure never authorizes cancellation';
const NO_CLIENT_NEXT_ACTION =
	'host status client unavailable: cancellation needs positive liveness evidence; use the human force path (/swarm abort-pr-workflow) for an unrecoverable orphan';

type ProbeOutcome =
	| { kind: 'ok'; map: Record<string, { type?: string }> }
	| {
			kind: 'degraded';
			reason:
				| 'probe-unavailable'
				| 'probe-error'
				| 'probe-timeout'
				| 'probe-no-data';
	  };

type BoundedOutcome<T> =
	| { kind: 'ok'; value: T }
	| { kind: 'timeout' }
	| { kind: 'error' };

/**
 * Race one host call against a bounded budget. A zero budget is an immediate
 * timeout; a real timer bounds the wall clock while the `_internals.now`
 * elapsed check additionally honors clock-driven (pinned) deadlines. Ordinary
 * errors are surfaced as `error` so callers keep today's asymmetry (only a
 * TIMEOUT suppresses the cancellation settle; an ordinary abort error does
 * not).
 */
async function raceWithBudget<T>(
	op: () => Promise<T>,
	budgetMs: number,
): Promise<BoundedOutcome<T>> {
	if (budgetMs <= 0) return { kind: 'timeout' };
	const startedAt = _internals.now();
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<'timeout'>((resolve) => {
		timer = setTimeout(() => {
			timedOut = true;
			resolve('timeout');
		}, budgetMs);
	});
	// Guard against an unhandled rejection when the deadline wins the race.
	const guarded = op().then(
		(value): { kind: 'ok'; value: T } | { kind: 'error' } => ({
			kind: 'ok',
			value,
		}),
		(): { kind: 'error' } => ({ kind: 'error' }),
	);
	try {
		const raced = await Promise.race([guarded, deadline]);
		if (raced === 'timeout') return { kind: 'timeout' };
		if (timedOut || _internals.now() - startedAt >= budgetMs) {
			return { kind: 'timeout' };
		}
		return raced;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function probeBatchStatus(
	session: SessionOps,
	directory: string,
): Promise<ProbeOutcome> {
	if (typeof session.status !== 'function') {
		return { kind: 'degraded', reason: 'probe-unavailable' };
	}
	const outcome = await raceWithBudget(
		() => session.status!({ query: { directory } }),
		_internals.probeBudgetMs,
	);
	if (outcome.kind === 'timeout') {
		return { kind: 'degraded', reason: 'probe-timeout' };
	}
	if (outcome.kind === 'error') {
		return { kind: 'degraded', reason: 'probe-error' };
	}
	const response = outcome.value;
	if (response.error || !response.data) {
		return { kind: 'degraded', reason: 'probe-no-data' };
	}
	return { kind: 'ok', map: response.data };
}

type AbortOutcome = 'ok' | 'timeout' | 'error';

async function boundedAbort(
	session: SessionOps,
	subagentSessionId: string,
	budgetMs: number,
): Promise<AbortOutcome> {
	if (typeof session.abort !== 'function') return 'error';
	const outcome = await raceWithBudget(
		() => session.abort!({ path: { id: subagentSessionId } }),
		budgetMs,
	);
	return outcome.kind;
}

function emptyDigest(): string {
	return createHash('sha256').update('').digest('hex');
}

export async function executeCancelLaneBatch(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<CancelLaneBatchResult> {
	const parsed = CancelLaneBatchArgsSchema.safeParse(args);
	if (!parsed.success) {
		return {
			success: false,
			failure_class: 'invalid_args',
			message: `Invalid cancel_lane_batch arguments: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
			batch_id: '',
			total_active: 0,
			cancelled: 0,
			refused: [],
			preserved_completions: [],
			already_settled: [],
			errors: [],
		};
	}
	// Review PRR-012: the reason is operator-authored but flows into durable
	// audit surfaces — strip control characters before any persistence.
	const { batch_id, lanes } = parsed.data;
	const reason = stripControlCharacters(parsed.data.reason);
	const batchFilter = context.sessionID
		? { parentSessionId: context.sessionID }
		: undefined;
	const batchRead = findByBatchIdDetailed(directory, batch_id, batchFilter);
	if (batchRead.status === 'uncertain') {
		return {
			success: false,
			failure_class: 'store_unreadable',
			message: `cancel_lane_batch refused: delegation store unreadable (${batchRead.reason})`,
			batch_id,
			total_active: 0,
			cancelled: 0,
			refused: [],
			preserved_completions: [],
			already_settled: [],
			errors: [],
		};
	}
	if (batchRead.value.length === 0) {
		return {
			success: false,
			failure_class: 'not_found',
			message: `cancel_lane_batch: no delegation records for batch "${batch_id}"`,
			batch_id,
			total_active: 0,
			cancelled: 0,
			refused: [],
			preserved_completions: [],
			already_settled: [],
			errors: [],
		};
	}
	const laneFilter = lanes ? new Set(lanes) : null;
	const activeRecords = batchRead.value.filter(
		(record) =>
			(record.status === 'pending' || record.status === 'running') &&
			(!laneFilter ||
				(record.laneId !== undefined && laneFilter.has(record.laneId))),
	);
	const result: CancelLaneBatchResult = {
		success: true,
		batch_id,
		total_active: activeRecords.length,
		cancelled: 0,
		refused: [],
		preserved_completions: [],
		already_settled: [],
		errors: [],
	};
	if (activeRecords.length === 0) {
		result.message =
			'cancel_lane_batch: no active (pending/running) lanes matched';
		return result;
	}

	const session = _internals.getSessionOps();
	if (!session) {
		for (const record of activeRecords) {
			result.refused.push({
				lane_id: record.laneId ?? record.correlationId,
				degraded_reason: 'probe-unavailable',
				next_action: NO_CLIENT_NEXT_ACTION,
			});
		}
		result.success = false;
		result.failure_class = 'no_client';
		result.message =
			'cancel_lane_batch refused: no host session client for a liveness preflight';
		return result;
	}

	const probe = await probeBatchStatus(session, directory);
	if (probe.kind === 'degraded') {
		result.success = false;
		result.failure_class = 'probe_degraded';
		result.message = `cancel_lane_batch refused: liveness probe degraded (${probe.reason}); no lane was aborted or settled; ${DEGRADED_NEXT_ACTION}`;
		return result;
	}
	const totalDeadline = _internals.now() + _internals.totalBudgetMs;
	// Lanes this call leaves pending without a terminal disposition: identity
	// re-read store unreadable, total budget exhausted, abort timeout, and
	// post-abort store unreadable. An ordinary abort-error lane is still
	// settled below, so it never counts here (round-2 review F1 + critic
	// F1-RESIDUAL).
	let unprocessed = 0;
	for (const record of activeRecords) {
		const laneId = record.laneId ?? record.correlationId;
		const sessionEntry = record.subagentSessionId
			? probe.map[record.subagentSessionId]
			: undefined;
		if (sessionEntry === undefined) {
			// Absent from a SUCCESSFUL probe: the host affirmatively does not
			// know this session (orphan) — confirmed cancellation may proceed.
		} else {
			const type = sessionEntry.type;
			if (type === 'busy' || type === 'retry') {
				result.refused.push({
					lane_id: laneId,
					host_status: type,
					next_action: LIVE_NEXT_ACTION,
				});
				continue;
			}
			if (type !== 'idle') {
				// Unrecognized status type: fail-closed refusal.
				result.refused.push({
					lane_id: laneId,
					host_status: type ?? 'unknown',
					next_action:
						'unrecognized host status type: refused fail-closed; poll again before cancelling',
				});
				continue;
			}
		}

		// Identity re-read: the durable record must still be the one the batch
		// snapshot saw, and still open.
		const reread = findByCorrelationIdDetailed(directory, record.correlationId);
		if (reread.status === 'uncertain') {
			result.errors.push(
				`lane ${laneId}: store unreadable (${reread.reason}); not cancelled`,
			);
			unprocessed += 1;
			continue;
		}
		const current = reread.value;
		if (!current) {
			result.already_settled.push(laneId);
			continue;
		}
		if (current.status !== 'pending' && current.status !== 'running') {
			result.already_settled.push(laneId);
			continue;
		}
		if (
			current.generation !== undefined &&
			record.generation !== undefined &&
			current.generation !== record.generation
		) {
			result.refused.push({
				lane_id: laneId,
				degraded_reason: 'identity-changed',
				next_action:
					'lane generation changed since the batch read: re-issue cancel_lane_batch',
			});
			continue;
		}

		const remainingMs = totalDeadline - _internals.now();
		if (remainingMs <= 0) {
			result.errors.push(
				`lane ${laneId}: cancel_lane_batch total budget exhausted before abort`,
			);
			unprocessed += 1;
			continue;
		}
		const abortOutcome = await boundedAbort(
			session,
			current.subagentSessionId,
			Math.min(_internals.abortBudgetMs, remainingMs),
		);
		if (abortOutcome === 'timeout') {
			// Never claim cancellation when the abort request itself timed out.
			result.errors.push(
				`session.abort for lane session "${current.subagentSessionId}" exceeded the bounded cancel budget; lane left pending`,
			);
			unprocessed += 1;
			continue;
		}
		if (abortOutcome === 'error') {
			// Review PRR-014 / round-2 F1: an ordinary abort error still gets
			// the best-effort exactly-once settle, but errors[] reports ONLY
			// the host-abort failure — never the outcome, which lands in the
			// per-lane lists or, if the store turns unreadable, in errors[].
			result.errors.push(
				`session.abort for lane session "${current.subagentSessionId}" failed; the best-effort exactly-once settle still runs`,
			);
		}

		// Post-abort re-read: a child that completed in the race window wins.
		const afterRead = findByCorrelationIdDetailed(
			directory,
			record.correlationId,
		);
		if (afterRead.status === 'uncertain') {
			result.errors.push(
				`lane ${laneId}: store unreadable after abort (${afterRead.reason}); not settled by this call`,
			);
			unprocessed += 1;
			continue;
		}
		const after = afterRead.value;
		if (after && after.status !== 'pending' && after.status !== 'running') {
			if (after.status === 'completed') {
				result.preserved_completions.push(laneId);
			} else {
				result.already_settled.push(laneId);
			}
			continue;
		}

		// Ordinary (non-timeout) abort errors keep today's best-effort
		// semantics: the settle still runs, through the exactly-once claim.
		const settle = await settleDelegationTerminal(
			directory,
			after ?? current,
			{
				status: 'cancelled',
				result: {
					error: `lane cancelled via cancel_lane_batch: ${reason}`,
					chars: 0,
					truncated: false,
					digest: emptyDigest(),
					workflowLaneFailureClass: 'operator_cancelled',
				},
			},
			{},
			_internals.now(),
		);
		if (settle.kind === 'claimed') {
			result.cancelled += 1;
		} else {
			result.already_settled.push(laneId);
		}
	}

	// Review PRR-003 / round-2 F1: surface only the lanes this call did not
	// carry to a terminal disposition, so a partial cancel is visible without
	// inspecting errors[] — an abort-error lane was processed (settled below).
	const tail =
		unprocessed > 0 ? `; ${unprocessed} not processed (see errors[])` : '';
	result.message =
		result.cancelled > 0
			? `cancel_lane_batch: ${result.cancelled} lane(s) cancelled (operator_cancelled); ${result.refused.length} refused; ${result.preserved_completions.length} preserved completions${tail}`
			: `cancel_lane_batch: no lanes cancelled; ${result.refused.length} refused, ${result.already_settled.length} already settled, ${result.preserved_completions.length} preserved completions${tail}`;
	return result;
}

export const cancel_lane_batch: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Explicitly cancel ACTIVE lanes of a dispatch_lanes_async batch. This is the ONLY cancellation surface — collect_lane_results cannot cancel anything. DESTRUCTIVE and authorization-gated: requires confirm: true plus a bounded reason, which are recorded on every cancelled lane terminal as the distinct operator_cancelled failure class (never liveness). Race-safe per lane: a fresh liveness snapshot REFUSES lanes the host reports busy or retry (live work is never destroyed here — the human force path is /swarm abort-pr-workflow); a degraded/absent status probe refuses the whole batch fail-closed (an observer failure never authorizes cancellation); a session the host affirmatively does not know (absent from a successful status map) or reports idle may be cancelled. A child that completes between preflight and abort wins and is preserved, never overwritten. An abort timeout never claims cancellation. Cancellation is terminal and exactly-once; an operator-cancelled dimension is not auto-retryable and never consumes the retry budget — re-dispatch explicitly if the dimension is still wanted.',
		args: {
			batch_id: CancelLaneBatchArgsSchema.shape.batch_id,
			reason: CancelLaneBatchArgsSchema.shape.reason,
			confirm: CancelLaneBatchArgsSchema.shape.confirm,
			lanes: CancelLaneBatchArgsSchema.shape.lanes,
		},
		execute: async (args: unknown, directory: string, ctx): Promise<string> => {
			const context = ctx as { sessionID?: string } | undefined;
			const result = await executeCancelLaneBatch(args, directory, {
				sessionID:
					context && typeof context.sessionID === 'string'
						? context.sessionID
						: undefined,
			});
			return JSON.stringify(result, null, 2);
		},
	});
