/**
 * TODO-gate evaluation (issue #2581): applies the `todo_gate` config to a
 * recorded `todo_scan` evidence field. Pure functions shared by BOTH
 * consumers — `check_gate_status` (per-task verdict) and the phase-complete
 * `todo_gate` gate — so the two surfaces can never disagree on threshold
 * semantics.
 */

import type { TodoScanEvidence } from '../gate-evidence.js';

/** Schema defaults from `src/config/schema.ts` (`todo_gate`). */
export const TODO_GATE_DEFAULTS = {
	enabled: true,
	max_high_priority: 0,
	block_on_threshold: false,
} as const;

export type TodoGateConfigBlock = {
	enabled?: boolean;
	max_high_priority?: number;
	block_on_threshold?: boolean;
};

export interface TodoGateVerdict {
	status: 'disabled' | 'no-evidence' | 'pass' | 'exceeded';
	/** True only when exceeded AND block_on_threshold — the only blocking shape. */
	blocked: boolean;
	/** True when exceeded without blocking — advisory warning, never blocks. */
	advisory: boolean;
	count: number;
	max: number;
	/** Evidence + repair text; present only when exceeded. */
	message?: string;
}

function formatDetails(details: string[] | undefined, count: number): string {
	if (!details || details.length === 0) return '';
	const lines = details.map((line) => `  - ${line}`).join('\n');
	return details.length < count
		? `${lines}\n  (showing first ${details.length} of ${count})`
		: lines;
}

function repairStep(): string {
	return (
		'Repair: resolve or remove the high-priority TODO comments listed above, ' +
		'or adjust the todo_gate config (raise max_high_priority / set enabled: false), ' +
		'then re-run todo_extract with the same task_id to refresh the recorded evidence.'
	);
}

/**
 * Exceeded ⇔ high-priority count > max_high_priority; max < 0 (-1) disables
 * the threshold check entirely; "at threshold" (count == max) does NOT
 * exceed (max is the maximum ALLOWED count).
 */
export function isTodoThresholdExceeded(
	count: number,
	maxHighPriority: number,
): boolean {
	return maxHighPriority >= 0 && count > maxHighPriority;
}

export function evaluateTodoGate(
	todoScan: TodoScanEvidence | null | undefined,
	todoGate: TodoGateConfigBlock | undefined,
): TodoGateVerdict {
	const enabled = todoGate?.enabled ?? TODO_GATE_DEFAULTS.enabled;
	const max =
		todoGate?.max_high_priority ?? TODO_GATE_DEFAULTS.max_high_priority;
	const blockOnThreshold =
		todoGate?.block_on_threshold ?? TODO_GATE_DEFAULTS.block_on_threshold;

	if (enabled === false) {
		return {
			status: 'disabled',
			blocked: false,
			advisory: false,
			count: 0,
			max,
		};
	}

	if (!todoScan) {
		return {
			status: 'no-evidence',
			blocked: false,
			advisory: false,
			count: 0,
			max,
		};
	}

	const count = todoScan.count;
	if (!isTodoThresholdExceeded(count, max)) {
		return {
			status: 'pass',
			blocked: false,
			advisory: false,
			count,
			max,
		};
	}

	const evidence = formatDetails(todoScan.details, count);
	const summary = `todo_gate: ${count} high-priority TODOs (FIXME/HACK/XXX) exceed max_high_priority=${max}.${
		evidence ? `\nEvidence:\n${evidence}` : ''
	}`;

	if (blockOnThreshold) {
		return {
			status: 'exceeded',
			blocked: true,
			advisory: false,
			count,
			max,
			message: `${summary}\n${repairStep()}`,
		};
	}

	return {
		status: 'exceeded',
		blocked: false,
		advisory: true,
		count,
		max,
		message: `${summary}\n${repairStep()}`,
	};
}
