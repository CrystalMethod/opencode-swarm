import { z } from 'zod';
import { forceRecoverReworkTask } from '../workflow/rework-recovery.js';
import { createSwarmTool } from './create-tool.js';

const RecoverReworkTaskArgsSchema = z
	.object({
		task_id: z
			.string()
			.trim()
			.min(1)
			.max(64)
			.describe(
				'Exact plan task id of the rework_required task (e.g. "1.1"). Must exist in the current plan and have durable workflow evidence at state rework_required.',
			),
		reason: z
			.string()
			.trim()
			.min(1)
			.max(500)
			.describe(
				'Why the Stage B verdict did not require a code change (e.g. "test_engineer returned SKIPPED for a tool-argument error while pytest passes"). Audited to .swarm/events.jsonl.',
			),
	})
	.strict();

export async function executeRecoverReworkTask(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<string> {
	const parsed = RecoverReworkTaskArgsSchema.safeParse(args);
	if (!parsed.success) {
		return JSON.stringify({
			success: false,
			message: `Invalid recover_rework_task call: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
		});
	}
	if (!context.sessionID?.trim()) {
		return JSON.stringify({
			success: false,
			message: 'recover_rework_task requires an active sessionID',
		});
	}
	try {
		const summary = await forceRecoverReworkTask(directory, context.sessionID, {
			taskId: parsed.data.task_id,
			reason: parsed.data.reason,
		});
		const auditNote = summary.auditEventRecorded
			? 'The recovery is audited to .swarm/events.jsonl (stage_a_repair action rework_recovered).'
			: 'WARNING: the audit event could NOT be appended to .swarm/events.jsonl (see the plugin log); the durable workflow evidence still records the supervised recovery via the rework-recovery: transition id.';
		return JSON.stringify({
			success: true,
			task_id: summary.taskId,
			generation: summary.generation,
			state: summary.state,
			transition_id: summary.transitionId,
			recorded_at: summary.recordedAt,
			audit_event_recorded: summary.auditEventRecorded,
			method: 'supervised_recovery',
			message:
				`Task ${summary.taskId} recovered from rework_required: a supervised stage_a_passed was written at generation ${summary.generation} ` +
				'(transition id ' +
				summary.transitionId +
				'). Reviewer/test_engineer dispatch is permitted again — re-run the Stage B gates that the failed verdict cleared. ' +
				auditNote +
				' Use it ONLY when the Stage B verdict did not require a code change; a genuine defect still needs the coder repair loop.',
		});
	} catch (error) {
		return JSON.stringify({
			success: false,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

export const recover_rework_task: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Recover a task wedged at rework_required when the Stage B verdict did NOT require a code change (issue #2755): writes a supervised stage_a_passed for the current generation so reviewer/test_engineer can be re-dispatched, without re-running the coder. Requires the exact plan task id, an active architect session, durable workflow state exactly rework_required, and green pre-check proof: green secretscan AND sast_scan evidence bundles newer than the failing verdict (normally from a fresh pre_check_batch run; bundle recency is global, not file-correlated; projects with SAST disabled cannot use this path). Fail-closed otherwise; the mechanical stage_a_passed path still requires an accepted coder mutation. A reason is required and audited to .swarm/events.jsonl (stage_a_repair action rework_recovered). Prefer the coder repair loop when the code actually has a defect.',
		args: {
			task_id: RecoverReworkTaskArgsSchema.shape.task_id,
			reason: RecoverReworkTaskArgsSchema.shape.reason,
		},
		execute: executeRecoverReworkTask,
	});
