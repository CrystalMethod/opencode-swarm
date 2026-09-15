/**
 * Execution-attempt trace records (issue #2676 / Workstream D16).
 *
 * Binds ONE observability event per execution attempt to the exact task, call,
 * invocation, and generation identity that produced it, with a closed
 * attempt/outcome class vocabulary and a per-attempt cost block whose unknown
 * axes are strictly `null` plus an `unavailable` list entry — never `0`, never
 * synthesized (the issue's "unknown is not zero" rule, already an envelope
 * invariant for IDs, extended to cost).
 *
 * Fail-open by construction (the Stage A route-event pattern): a vocabulary or
 * identity violation is logged warn-only and the record is dropped, because
 * this recorder runs on hook paths where a thrown error would corrupt the
 * lifecycle it observes.
 *
 * Import rules: no filesystem, network, subprocess, or OTel SDK. The only
 * side effect is the telemetry emit.
 */
import { emit } from '../telemetry.js';
import { warn } from '../utils/logger.js';

/** Closed attempt/outcome record-class vocabulary (issue #2676 AC1). */
export type ExecutionAttemptClass =
	| 'denial'
	| 'attempt'
	| 'result'
	| 'duplicate'
	| 'late'
	| 'cancelled'
	| 'provider_failed';

export const EXECUTION_ATTEMPT_CLASSES: readonly ExecutionAttemptClass[] = [
	'denial',
	'attempt',
	'result',
	'duplicate',
	'late',
	'cancelled',
	'provider_failed',
] as const;

/** Terminal disposition of the attempt, when the producer reported one. */
export type ExecutionAttemptOutcomeStatus =
	| 'success'
	| 'failure'
	| 'partial'
	| 'unknown';

/** The frozen per-attempt cost axes (issue #2676 AC2). */
export const TASK_ATTEMPT_COST_AXES = [
	'latencyMs',
	'inputTokens',
	'outputTokens',
	'cacheReadTokens',
	'estimatedCostUsd',
	'billedCostUsd',
] as const;

export type TaskAttemptCostAxis = (typeof TASK_ATTEMPT_COST_AXES)[number];

/** Caller-held cost facts. An absent key means the producer did not hold it. */
export interface TaskAttemptCostInput {
	taskId?: string;
	attemptId?: string;
	latencyMs?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	estimatedCostUsd?: number;
	billedCostUsd?: number;
}

/**
 * The built cost record: every axis is `number | null`, `null` meaning the
 * producer did not hold the value, with `unavailable` listing exactly the
 * axes that are null. Zero is a legal KNOWN value (zero tokens used) and is
 * never produced as a fallback for a missing input.
 */
export interface TaskAttemptCost
	extends Record<TaskAttemptCostAxis, number | null> {
	taskId?: string;
	attemptId?: string;
	unavailable: readonly string[];
}

/** A known axis value must be finite and non-negative to count as held. */
function knownCostValue(value: number | undefined): number | null {
	if (value === undefined) return null;
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		return null;
	}
	return value;
}

/**
 * Build the per-attempt cost record. Caller-omitted (or invalid) axes are
 * strictly `null` AND listed in `unavailable`; known axes pass through
 * verbatim and never appear in `unavailable`.
 */
export function buildTaskAttemptCost(
	partial: TaskAttemptCostInput,
): TaskAttemptCost {
	const unavailable: string[] = [];
	const record: TaskAttemptCost = {
		latencyMs: null,
		inputTokens: null,
		outputTokens: null,
		cacheReadTokens: null,
		estimatedCostUsd: null,
		billedCostUsd: null,
		unavailable,
	};
	if (partial.taskId !== undefined) record.taskId = partial.taskId;
	if (partial.attemptId !== undefined) record.attemptId = partial.attemptId;
	for (const axis of TASK_ATTEMPT_COST_AXES) {
		const value = knownCostValue(partial[axis]);
		if (value === null) {
			unavailable.push(axis);
		} else {
			record[axis] = value;
		}
	}
	return record;
}

/** Recorder input. `sessionID`/`callID` are the Stage A casing aliases. */
export interface ExecutionAttemptInput {
	sessionId?: string;
	/** Stage A casing alias for {@link sessionId}; normalized before emit. */
	sessionID?: string;
	taskId?: string;
	callId?: string;
	/** Stage A casing alias for {@link callId}; normalized before emit. */
	callID?: string;
	invocationId?: string;
	/**
	 * Monotonic generation cursor for the (task, call) pair. REQUIRED for
	 * class `late` — it is the cursor the record was late against. A `late`
	 * caller that cannot supply it is refused fail-open with a warn, never
	 * silently downgraded.
	 */
	generation?: number;
	retryIndex?: number;
	laneId?: string;
	knowledgeTraceId?: string;
	attemptClass: ExecutionAttemptClass;
	outcomeStatus?: ExecutionAttemptOutcomeStatus;
	/**
	 * Identity (record_id / event id) of the already-committed record this
	 * one duplicates. REQUIRED for class `duplicate`; never synthesized — a
	 * duplicate caller holding no original identity is refused fail-open.
	 */
	duplicateOf?: string;
	cost?: TaskAttemptCostInput;
}

/** Sanitize an identifier for emission: printable, bounded (Stage A pattern). */
function boundedId(value: string | undefined): string | undefined {
	if (typeof value !== 'string') return undefined;
	const cleaned = value.replace(/[\r\n\t]/g, '_').trim();
	if (cleaned === '') return undefined;
	return cleaned.slice(0, 128);
}

/**
 * Record ONE execution attempt as an `execution_attempt_recorded` telemetry
 * event. Fail-open: invalid input logs a warn and returns without emitting.
 */
export function recordExecutionAttempt(input: ExecutionAttemptInput): void {
	if (input === null || typeof input !== 'object') return;
	if (!EXECUTION_ATTEMPT_CLASSES.includes(input.attemptClass)) {
		warn('Execution attempt record rejected: class outside closed vocabulary', {
			attemptClass: String(input.attemptClass),
		});
		return;
	}

	// Stage A casing aliases normalize to the extractor's payload keys.
	const sessionId = boundedId(input.sessionId ?? input.sessionID);
	if (sessionId === undefined) {
		warn('Execution attempt record rejected: no session identity', {
			attemptClass: input.attemptClass,
		});
		return;
	}
	const callId = boundedId(input.callId ?? input.callID);
	const taskId = boundedId(input.taskId);
	const invocationId = boundedId(input.invocationId);
	const laneId = boundedId(input.laneId);
	const knowledgeTraceId = boundedId(input.knowledgeTraceId);

	if (input.attemptClass === 'late') {
		if (
			typeof input.generation !== 'number' ||
			!Number.isInteger(input.generation) ||
			input.generation < 0
		) {
			warn(
				'Execution attempt record rejected: late record carries no generation cursor',
				{ attemptClass: input.attemptClass, taskId },
			);
			return;
		}
	}
	if (input.attemptClass === 'duplicate') {
		const dup = boundedId(input.duplicateOf);
		if (dup === undefined) {
			warn(
				'Execution attempt record rejected: duplicate record carries no original identity',
				{ attemptClass: input.attemptClass, taskId },
			);
			return;
		}
	}

	// Capture coverage: which join fields the producer genuinely held. A
	// missing capture stays explicit — it is listed, never fabricated.
	const captured: string[] = ['sessionId'];
	const unknown: string[] = [];
	for (const [field, held] of [
		['taskId', taskId],
		['callId', callId],
		['invocationId', invocationId],
		['generation', input.generation],
		['retryIndex', input.retryIndex],
		['laneId', laneId],
		['knowledgeTraceId', knowledgeTraceId],
	] as const) {
		if (held === undefined) {
			unknown.push(field);
		} else {
			captured.push(field);
		}
	}

	const cost = buildTaskAttemptCost(input.cost ?? {});
	for (const axis of cost.unavailable) unknown.push(`cost.${axis}`);
	for (const axis of TASK_ATTEMPT_COST_AXES) {
		if (cost[axis] !== null) captured.push(`cost.${axis}`);
	}

	const payload: Record<string, unknown> = {
		sessionId,
		attemptClass: input.attemptClass,
		outcomeStatus: input.outcomeStatus ?? 'unknown',
		captured,
		unknown,
		cost,
	};
	if (taskId !== undefined) payload.taskId = taskId;
	if (callId !== undefined) payload.callId = callId;
	if (invocationId !== undefined) payload.invocationId = invocationId;
	if (typeof input.generation === 'number')
		payload.generation = input.generation;
	if (typeof input.retryIndex === 'number')
		payload.retryIndex = input.retryIndex;
	if (laneId !== undefined) payload.laneId = laneId;
	if (knowledgeTraceId !== undefined) {
		payload.knowledgeTraceId = knowledgeTraceId;
	}
	if (input.attemptClass === 'duplicate') {
		payload.duplicateOf = boundedId(input.duplicateOf);
	}

	emit('execution_attempt_recorded', payload);
}

export const _internals = {
	boundedId,
	knownCostValue,
};
