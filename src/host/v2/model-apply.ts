/**
 * v2 runtime agent-model application (issue #3022, AC3).
 *
 * The v1 fallback loop closes through `output.message.model` at the
 * chat.message boundary — a surface the v2 SessionPrompt event does not carry
 * (docs/host/v2-hook-inventory.md row 13). The v2-native equivalent is
 * rewriting the agent's `model` reference through the host-provided
 * `ctx.agent.transform` entry: the AgentDraft editor is callback-scoped
 * (src/host/v2/agents-commands.ts registers through the same primitive), so
 * the apply re-invokes the stored transform surface at advance time.
 *
 * KEYING CONTRACT (plan-critic round 2): the v2 AgentEditor is keyed by the
 * EXACT REGISTERED agent name (multi-swarm configs register `local_coder`
 * etc.), and `editor.update(id, fn)` is create-or-update — callers MUST pass
 * the registration key (`routeModel.exactAgentName`), never the bare
 * prefix-stripped role, or a phantom bare-name agent would be created.
 *
 * Everything here is fail-open: with no registered surface (v1 hosts, or a v2
 * host without the agent domain) the apply is a logged no-op.
 */

import { log } from '../../utils';
import { withTimeout } from '../../utils/timeout';
import type { V2AgentEditor, V2PluginContext } from './types';

const V2_MODEL_APPLY_TIMEOUT_MS = 10_000;

type AgentTransform = V2PluginContext['agent']['transform'];

let registeredTransform: AgentTransform | undefined;

/**
 * Remember the v2 agent transform surface for later model rewrites. Called
 * once from setup after agent registration; cleared on cleanup.
 */
export function registerV2AgentTransformSurface(ctx: V2PluginContext): void {
	const transform =
		ctx?.agent && typeof ctx.agent.transform === 'function'
			? ctx.agent.transform.bind(ctx.agent)
			: undefined;
	registeredTransform = transform;
	if (transform === undefined) {
		log('v2 agent transform surface absent; runtime model apply disabled', {});
	}
}

/** Drop the registered surface (v2 cleanup). */
export function clearV2AgentTransformSurface(): void {
	registeredTransform = undefined;
}

/** True when a v2 apply surface is registered (test/diagnostic seam). */
export function hasV2AgentTransformSurface(): boolean {
	return registeredTransform !== undefined;
}

/**
 * Rewrite one registered agent's model to `modelString` ('provider/model').
 * Returns true when a surface existed and the transform completed within the
 * budget; false (logged, non-fatal) otherwise. No-op on v1 hosts.
 */
export async function applyV2AgentModelOverride(
	agentName: string,
	modelString: string,
): Promise<boolean> {
	const transform = registeredTransform;
	if (transform === undefined) {
		// v1 host or pre-cleanup: the v1 chat-boundary override owns application.
		return false;
	}
	const separator = modelString.indexOf('/');
	if (
		typeof agentName !== 'string' ||
		agentName.length === 0 ||
		separator <= 0 ||
		separator === modelString.length - 1
	) {
		log('v2 model apply rejected malformed input (non-fatal)', {
			agentName,
			modelString,
		});
		return false;
	}
	const providerID = modelString.slice(0, separator);
	const id = modelString.slice(separator + 1);
	try {
		await withTimeout(
			Promise.resolve(
				transform((editor: V2AgentEditor) => {
					// update(id, fn) is create-or-update; agentName must be the
					// registered key (see module header KEYING CONTRACT).
					editor.update(agentName, (agent) => {
						agent.model = { providerID, id };
					});
				}),
			),
			V2_MODEL_APPLY_TIMEOUT_MS,
			new Error(
				`[opencode-swarm] v2: model apply for ${agentName} exceeded budget`,
			),
		);
		log('v2 agent model applied', { agentName, modelString });
		return true;
	} catch (err) {
		log('v2 agent model apply failed (non-fatal)', {
			agentName,
			modelString,
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}
