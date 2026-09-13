/**
 * System render boundary (issue #2673).
 *
 * The final request boundary for the SYSTEM surface. The pinned host
 * (@opencode-ai 1.18.3 — anomalyco/opencode@v1.18.3,
 * packages/opencode/src/session/llm/request.ts, LLMRequestPrep.prepare)
 * triggers `experimental.chat.system.transform` with `{ sessionID?, model }`
 * and the SHARED `system` array, then coalesces only when
 * `system.length > 2 && system[0] === header`, and materializes EVERY
 * surviving entry as a separate `{role:'system'}` message ahead of the
 * conversation. With plugin guidance entries present, every non-OAuth
 * provider therefore receives exactly two system messages.
 *
 * Strict single-system providers (Qwen3.6/Gemma class — the documented
 * v6.85.1 incident: "require exactly one `{role:'system'}` message at
 * index 0") crash or silently degrade on that shape. An UNCONDITIONAL
 * collapse is wrong (issue #1619): the host marks prompt-cache breakpoints
 * on the first two system messages, so folding the stable base prompt
 * together with per-request injections would move the breakpoint behind
 * varying content and defeat caching for cache-capable providers.
 *
 * This module resolves the per-request rendering capability from the model
 * the host hands the boundary and collapses ONLY for strict single-system
 * models, IN PLACE (`length = 0` + `push` — the #1619 discipline: the host
 * discards hook return values and reads its own array). Everything else is
 * left byte-identical.
 *
 * Known limitation (plan-critic round 1, finding 1): host request paths that
 * bypass `output.system` — OpenAI OAuth and workflow models consume the
 * system surface via `options.instructions` — cannot be shaped by any plugin
 * hook and are out of scope.
 */

import { log } from '../utils/logger.js';

/** Rendering classes the boundary distinguishes. */
export type SystemRenderCapability = 'strict-single-system' | 'multi-system';

/** Bounded, observable result of one boundary application. */
export interface SystemRenderBoundaryResult {
	capability: SystemRenderCapability;
	entriesBefore: number;
	entriesAfter: number;
	collapsed: boolean;
}

/**
 * Provider prefixes whose request shape supports MULTIPLE system entries with
 * prompt-cache breakpoints on the first two (host `nk()` per the v6.85.1
 * entry). Evaluated FIRST so a strict-family model id served behind one of
 * these gateways is never collapsed (ladder symmetry, plan-critic finding 2).
 */
const CACHE_CAPABLE_PROVIDER_PREFIXES = ['anthropic'] as const;

/**
 * Model-id families documented to accept exactly one system message
 * (docs/engineering-invariants.md §v6.85.1: Qwen3.6/Gemma local-model crash
 * class). The family token must start a segment (`qwen3.6-32b`,
 * `mistral-qwen-...`); embedded inside another word (`notqwen`) it is NOT a
 * match.
 */
const STRICT_FAMILY_PATTERN = /(?:^|[^a-z0-9])(?:qwen|gemma)/i;

/** Read a string field off the host `Model` object without throwing. */
function readModelStringField(model: unknown, key: string): string {
	if (typeof model !== 'object' || model === null) return '';
	const value = (model as Record<string, unknown>)[key];
	return typeof value === 'string' ? value : '';
}

/**
 * Resolve the rendering capability for one request's model. Fail-open:
 * anything unreadable or unknown resolves to `multi-system`, which leaves the
 * array byte-identical (the pre-#2673 behavior), so the boundary can never
 * regress a provider it does not positively know to be strict.
 */
export function resolveSystemRenderCapability(
	model: unknown,
): SystemRenderCapability {
	const providerID = readModelStringField(model, 'providerID').toLowerCase();
	if (
		CACHE_CAPABLE_PROVIDER_PREFIXES.some((prefix) =>
			providerID.startsWith(prefix),
		)
	) {
		return 'multi-system';
	}
	const modelID = readModelStringField(model, 'id');
	if (modelID.length > 0 && STRICT_FAMILY_PATTERN.test(modelID)) {
		return 'strict-single-system';
	}
	return 'multi-system';
}

/**
 * Apply the boundary to one request's system array, in place.
 *
 * Strict single-system models with more than one entry: empty-string entries
 * are dropped, the rest are joined with a blank line (base prompt first —
 * every producer appends after the host's pre-joined header), and the array is
 * collapsed to exactly ONE entry via `length = 0` + `push`. Multi-system
 * models: no mutation at all. Length ≤ 1: no-op. Never fabricates or reorders
 * non-empty content.
 */
export function applySystemRenderBoundary(
	model: unknown,
	system: string[],
): SystemRenderBoundaryResult {
	const capability = resolveSystemRenderCapability(model);
	if (!Array.isArray(system)) {
		return {
			capability,
			entriesBefore: -1,
			entriesAfter: -1,
			collapsed: false,
		};
	}
	const entriesBefore = system.length;
	if (capability !== 'strict-single-system' || entriesBefore <= 1) {
		return {
			capability,
			entriesBefore,
			entriesAfter: entriesBefore,
			collapsed: false,
		};
	}
	const nonEmpty = system.filter(
		(entry) => typeof entry === 'string' && entry.length > 0,
	);
	if (nonEmpty.length === 0) {
		return {
			capability,
			entriesBefore,
			entriesAfter: entriesBefore,
			collapsed: false,
		};
	}
	const joined = nonEmpty.join('\n\n');
	system.length = 0;
	system.push(joined);
	return { capability, entriesBefore, entriesAfter: 1, collapsed: true };
}

/**
 * Hook factory for the `experimental.chat.system.transform` chain. Registered
 * LAST (after every producer, including the role filter) so the shape is
 * finalized once, after all pushes and prunes. Fail-open: any throw leaves the
 * array untouched and logs non-fatally.
 */
export function createSystemRenderBoundaryHook(): {
	'experimental.chat.system.transform': (
		input: unknown,
		output: unknown,
	) => Promise<void>;
} {
	return {
		'experimental.chat.system.transform': async (
			input: unknown,
			output: unknown,
		): Promise<void> => {
			try {
				const model =
					typeof input === 'object' && input !== null
						? (input as { model?: unknown }).model
						: undefined;
				const system =
					typeof output === 'object' && output !== null
						? (output as { system?: unknown }).system
						: undefined;
				if (model === undefined || model === null) {
					// Observable blind-spot line (plan-critic finding 1): the host
					// always hands this hook a model; its absence is worth a
					// debug-gated diagnostic rather than silence.
					log(
						'[system-render-boundary] no model on input; leaving system surface untouched (multi-system)',
					);
					return;
				}
				if (!Array.isArray(system)) return;
				const result = applySystemRenderBoundary(model, system as string[]);
				if (result.collapsed) {
					log(
						`[system-render-boundary] strict-single-system collapse: ${result.entriesBefore} -> 1 entry (${joinedByteLength(system)} bytes)`,
					);
				}
			} catch (error) {
				log(
					`[system-render-boundary] fail-open, system surface untouched: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		},
	};
}

function joinedByteLength(system: string[]): number {
	return system[0]?.length ?? 0;
}
