import { z } from 'zod';
import { recoverStageATaskSupervised } from '../workflow/settlement-recovery.js';
import { createSwarmTool } from './create-tool.js';

const RecoverStageATaskArgsSchema = z
	.object({
		task_id: z
			.string()
			.trim()
			.min(1)
			.max(64)
			.describe(
				'Exact task id of the settlement-wedged task (e.g. "1.1"). Must have durable workflow evidence at state idle or blocked, a COMMITTED accepted coder settlement, and green post-settlement pre-check proof.',
			),
		reason: z
			.string()
			.trim()
			.min(1)
			.max(500)
			.describe(
				'Why the settlement-backed recovery is justified (e.g. "settlement COMMITTED and pre_check_batch green but stage_a_passed never fired; force-repair cleared the proofs"). Audited to .swarm/events.jsonl.',
			),
	})
	.strict();

export async function executeRecoverStageATask(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<string> {
	const parsed = RecoverStageATaskArgsSchema.safeParse(args);
	if (!parsed.success) {
		return JSON.stringify({
			success: false,
			message: `Invalid recover_stage_a_task call: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
		});
	}
	if (!context.sessionID?.trim()) {
		return JSON.stringify({
			success: false,
			message: 'recover_stage_a_task requires an active sessionID',
		});
	}
	try {
		const summary = await recoverStageATaskSupervised(
			directory,
			context.sessionID,
			{
				taskId: parsed.data.task_id,
				reason: parsed.data.reason,
			},
		);
		if (summary.alreadyRecovered) {
			return JSON.stringify({
				success: true,
				task_id: summary.taskId,
				generation: summary.generation,
				state: summary.state,
				already_recovered: true,
				message: `Task ${summary.taskId} already has Stage A recorded (state ${summary.state}, generation ${summary.generation}) — nothing to recover.`,
			});
		}
		const auditNote = summary.auditEventRecorded
			? 'The recovery is audited to .swarm/events.jsonl (stage_a_repair action repaired, via recover_stage_a_task).'
			: 'WARNING: the audit event could NOT be appended to .swarm/events.jsonl (see the plugin log); the durable workflow evidence still records the settlement-backed recovery via the stage-a-supervised: transition id and the settlementRecovery marker.';
		return JSON.stringify({
			success: true,
			task_id: summary.taskId,
			generation: summary.generation,
			state: summary.state,
			transition_id: summary.transitionId,
			recorded_at: summary.recordedAt,
			audit_event_recorded: summary.auditEventRecorded,
			method: 'settlement_recovery',
			message:
				`Task ${summary.taskId} recovered from the settlement wedge: a settlement-backed stage_a_passed was written at generation ${summary.generation} ` +
				'(transition id ' +
				summary.transitionId +
				'). Reviewer/test_engineer dispatch is permitted again — run the Stage B gates the task still needs. ' +
				auditNote +
				' Use it ONLY when a COMMITTED accepted settlement and green post-settlement pre-check proof already justify Stage A; it never re-runs the coder and never edits gate evidence.',
		});
	} catch (error) {
		return JSON.stringify({
			success: false,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

export const recover_stage_a_task: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Recover a task wedged in the settlement-backed Stage A deadlock (issue #2828): workflow at idle or blocked while a COMMITTED accepted coder settlement and green post-settlement pre-check proof (green secretscan AND sast_scan evidence newer than the settlement commit) still justify Stage A — the shape where stage_a_passed never fired, a force-repair cleared the proofs, and every other recovery path refuses. Writes a settlement-backed stage_a_passed for the current generation so reviewer/test_engineer can be dispatched, without re-running the coder and without editing gate evidence. Requires the exact plan task id, an active architect session, a reason (audited), and durable workflow evidence at exactly idle/blocked. Fail-closed otherwise (RECOVER_STAGE_A_* errors); the mechanical stage_a_passed path still requires an accepted coder mutation or the #2665 live_wedge scan.',
		args: {
			task_id: RecoverStageATaskArgsSchema.shape.task_id,
			reason: RecoverStageATaskArgsSchema.shape.reason,
		},
		execute: executeRecoverStageATask,
	});
