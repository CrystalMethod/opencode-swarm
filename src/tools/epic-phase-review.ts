/**
 * Epic Mode phase review tool (`epic_phase_review`).
 *
 * Satisfies the `epic_phase_readiness` gate in `phase_complete`. The tool —
 * not the architect — dispatches a read-only phase reviewer and, when the
 * reviewer APPROVES, a read-only phase critic through the plugin-owned review
 * dispatcher, parses each verdict from the agent's own response, and records
 * both to `.swarm/evidence/{phase}/epic-phase-review.json` bound to the
 * current plan / phase task state. See `src/turbo/epic/phase-readiness.ts`.
 */

import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import type { ReviewModelDispatcher } from '../review/contracts.js';
import type { ReviewAgentModelRegistry } from '../review/runtime.js';
import {
	type EpicPhaseReviewRunResult,
	runEpicPhaseReview,
} from '../turbo/epic/phase-readiness.js';
import { isEpicModeActiveForProject } from '../turbo/epic/state.js';
import { createSwarmTool } from './create-tool.js';

export type EpicPhaseReviewToolResult =
	| EpicPhaseReviewRunResult
	| {
			success: false;
			phase: number;
			reason: 'epic-mode-not-active' | 'no-session' | 'invalid-phase';
			message: string;
	  };

/**
 * DI seam (AGENTS.md invariant 7); restore in afterEach.
 * @tool-opt-out Test-only dependency-injection seam; not a public tool.
 */
export const _internals = {
	runEpicPhaseReview,
	isEpicModeActiveForProject,
};

export async function executeEpicPhaseReview(
	args: { phase: number },
	directory: string,
	sessionID: string | undefined,
	options: {
		dispatcher?: ReviewModelDispatcher;
		generatedAgentNames?: readonly string[];
		agentModelRegistry?: ReviewAgentModelRegistry;
		activeAgentName?: string;
	} = {},
): Promise<EpicPhaseReviewToolResult> {
	const phase = Number(args.phase);
	if (!Number.isInteger(phase) || phase < 1) {
		return {
			success: false,
			phase,
			reason: 'invalid-phase',
			message: 'phase must be a positive integer',
		};
	}
	if (!sessionID) {
		return {
			success: false,
			phase,
			reason: 'no-session',
			message:
				'epic_phase_review must be called from an architect session (no sessionID in tool context).',
		};
	}
	if (!_internals.isEpicModeActiveForProject(directory)) {
		return {
			success: false,
			phase,
			reason: 'epic-mode-not-active',
			message:
				'Epic Mode is not active for this project; the Epic phase review is only required (and only recorded) while Epic Mode is on.',
		};
	}
	return _internals.runEpicPhaseReview(directory, phase, sessionID, options);
}

export function createEpicPhaseReviewTool(
	dispatcher?: ReviewModelDispatcher,
	generatedAgentNames?: readonly string[],
	agentModelRegistry?: ReviewAgentModelRegistry,
	getActiveAgentName?: (sessionID: string) => string | undefined,
): ToolDefinition {
	return createSwarmTool({
		description:
			'Epic Mode phase readiness: dispatch a read-only phase reviewer and then (only if it APPROVES) a read-only phase critic over the completed phase, parse their verdicts, and record them to .swarm/evidence/{phase}/epic-phase-review.json. ' +
			'Required by phase_complete while Epic Mode is active. Call after every task in the phase is completed; re-run after any fix (evidence goes stale when task gate evidence or the plan changes). ' +
			'Takes only the phase number — verdicts come from the dispatched agents, never from arguments.',
		args: {
			phase: z
				.number()
				.int()
				.positive()
				.describe('Phase number whose completed work should be reviewed'),
		},
		execute: async (args: unknown, directory: string, ctx) => {
			const sessionID = ctx?.sessionID;
			const result = await executeEpicPhaseReview(
				args as { phase: number },
				directory,
				sessionID,
				{
					dispatcher,
					generatedAgentNames,
					agentModelRegistry,
					activeAgentName:
						ctx?.agent !== undefined
							? String(ctx.agent)
							: sessionID
								? getActiveAgentName?.(sessionID)
								: undefined,
				},
			);
			return JSON.stringify(result, null, 2);
		},
	});
}

export const epic_phase_review: ToolDefinition = createEpicPhaseReviewTool();
