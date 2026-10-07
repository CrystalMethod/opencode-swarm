/**
 * TODO gate (issue #2581) — phase-completion consumer for recorded
 * `todo_scan` evidence. Warns (advisory) or blocks (block_on_threshold)
 * when ANY task in the phase carries a recorded high-priority TODO count
 * above the configured `max_high_priority`.
 *
 * A gate cannot block without an available producer: when no task in the
 * phase has `todo_scan` evidence, the gate passes with zero warnings. The
 * gate is registered among the standard gates (uniform Turbo bypass); the
 * disabled-config short-circuit lives INSIDE this function so the gate
 * report shows a plain pass, not `not_applicable`.
 */

import { readTaskEvidence } from '../../../gate-evidence.js';
import { loadPlan } from '../../../plan/manager';
import { evaluateTodoGate } from '../../../todo/todo-gate.js';
import type { GateContext, GateResult } from './types';

export async function runTodoGateGate(ctx: GateContext): Promise<GateResult> {
	const { phase, dir, agentsDispatched, pluginConfig, safeWarn } = ctx;
	const pass = (): GateResult => ({
		blocked: false,
		agentsDispatched,
		agentsMissing: [],
		warnings: [],
	});

	if (pluginConfig.todo_gate?.enabled === false) {
		return pass();
	}

	let taskIds: string[];
	try {
		const plan = await loadPlan(dir);
		const phaseRecord = plan?.phases.find((p) => p.id === phase);
		if (!phaseRecord) {
			// No plan / phase absent: no evidence source to evaluate — a gate
			// cannot block without an available producer.
			safeWarn(
				`todo_gate: no plan phase ${phase} found; gate passed without evidence`,
				undefined,
			);
			return pass();
		}
		taskIds = phaseRecord.tasks.map((task) => task.id);
	} catch (planError) {
		safeWarn(
			'todo_gate: plan load failed; gate passed without evidence',
			planError,
		);
		return pass();
	}

	const warnings: string[] = [];
	for (const taskId of taskIds) {
		let evidence = null;
		try {
			evidence = await readTaskEvidence(dir, taskId);
		} catch (evidenceError) {
			// Missing or unparseable per-task evidence is treated as
			// no-evidence for that task, never a gate failure.
			safeWarn(
				`todo_gate: task ${taskId} evidence unreadable; skipped`,
				evidenceError,
			);
			continue;
		}
		const verdict = evaluateTodoGate(
			evidence?.todo_scan,
			pluginConfig.todo_gate,
		);
		if (verdict.status !== 'exceeded') {
			continue;
		}
		if (verdict.blocked) {
			return {
				blocked: true,
				reason: 'TODO_GATE_THRESHOLD_EXCEEDED',
				message: `Phase ${phase} cannot be completed: task ${taskId} todo_gate threshold exceeded. ${verdict.message ?? ''}`,
				agentsDispatched,
				agentsMissing: [],
				warnings: [
					`todo_gate: task ${taskId} has ${verdict.count} high-priority TODOs (max ${verdict.max})`,
				],
				recovery: {
					kind: 'tool' as const,
					action: 'todo_extract',
					args: { task_id: taskId },
				},
				recoveryGuidance:
					'Resolve or remove the high-priority TODO comments listed in the gate message, or adjust the todo_gate config (raise max_high_priority / set enabled: false), then re-run todo_extract with the same task_id to refresh the recorded evidence.',
			};
		}
		warnings.push(
			`todo_gate advisory: task ${taskId} — ${verdict.count} high-priority TODOs (FIXME/HACK/XXX) exceed max_high_priority=${verdict.max}. ${verdict.message ?? ''}`,
		);
	}

	return {
		blocked: false,
		agentsDispatched,
		agentsMissing: [],
		warnings,
	};
}
