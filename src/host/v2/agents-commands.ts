/**
 * v2 agent + command registration (issue #3004 / #2910).
 *
 * Single-source design: the v1 `config` hook IS the shared builder. This
 * module invokes `hooks.config` against a synthetic `opencodeConfig` object
 * and registers the resulting `.agent` / `.command` tables onto the v2 agent
 * and command domains — the auto-select promotions and the entire v1 command table are reused with
 * zero extraction from src/index.ts (the v1 TUI shortcut block stays
 * byte-pinned). DELTA: the lane-permission mutations the v1 hook writes into
 * the config object (applyLanePermissions) have no v2 destination here and
 * are dropped - external-directory lane scoping is a #2910 follow-up row in
 * docs/host/v2-hook-inventory.md.
 *
 * Mappings (docs/host/v2-hook-inventory.md rows 4-5):
 *   - v1 AgentConfig → v2 Agent.Info: `prompt`→`system`, `mode` preserved
 *     (multi-swarm `*_architect` primary semantics — AGENTS.md invariant 11),
 *     `model` string 'provider/model' → Model.Ref, `tools` allowlist →
 *     per-tool allow permission rules (best-effort; see inventory).
 *   - Entries the v1 hook marks `disable: true` (auto-select disabling the
 *     `build`/`plan` built-ins) are REMOVED on the v2 agent editor.
 *   - v1 command entries `{template, description}` → v2 CommandDefinition
 *     whose `execute` natively dispatches through the shared v1 command
 *     handler (`command.execute.before` on the hooks object) and submits the
 *     handler-produced prompt via the v2 session prompt surface; the raw
 *     expanded template survives as the explicit fallback (#3169 Phase 4 —
 *     see deferredV2ExecuteSwarmCommand).
 */

import { log } from '../../utils';
import { withTimeout } from '../../utils/timeout';
import type {
	V1HooksSubset,
	V2AgentEditor,
	V2AgentInfo,
	V2CommandDefinition,
	V2CommandInvocation,
	V2PluginContext,
	V2Registration,
} from './types';

const V2_REGISTRATION_TIMEOUT_MS = 60_000;
/** Dispatch budget for one /swarm command execution (#3169 Phase 4). */
const V2_COMMAND_DISPATCH_TIMEOUT_MS = 300_000;

/**
 * Test seam (review PRR-002): the dispatch budget is read through this
 * object so the timeout→notice arm is reachable in tests without patching
 * global timers.
 */
export const _internals = {
	dispatchTimeoutMs: V2_COMMAND_DISPATCH_TIMEOUT_MS,
};

interface V1AgentConfigLike {
	mode?: unknown;
	prompt?: unknown;
	description?: unknown;
	model?: unknown;
	tools?: unknown;
	disable?: unknown;
}

/** Map one v1 AgentConfig entry to a v2 Agent.Info. */
export function mapV1AgentToV2(
	name: string,
	config: V1AgentConfigLike,
): V2AgentInfo {
	const info: V2AgentInfo = {
		id: name,
		name,
		mode:
			config.mode === 'primary' ||
			config.mode === 'subagent' ||
			config.mode === 'all'
				? config.mode
				: 'subagent',
		hidden: false,
		request: { settings: {}, headers: {}, body: {} },
	};
	if (typeof config.prompt === 'string' && config.prompt.length > 0) {
		info.system = config.prompt;
	}
	if (typeof config.description === 'string' && config.description.length > 0) {
		info.description = config.description;
	}
	if (typeof config.model === 'string' && config.model.includes('/')) {
		const separator = config.model.indexOf('/');
		info.model = {
			providerID: config.model.slice(0, separator),
			id: config.model.slice(separator + 1),
		};
	}
	// The v1 `tools` field carries either an allowlist (string[]) or an
	// override/permission map (Record<string, boolean>); true/absent stays
	// enabled, false disables. Map enabled entries to per-tool allow rules.
	const rules: NonNullable<V2AgentInfo['permissions']> = [];
	if (Array.isArray(config.tools)) {
		for (const tool of config.tools) {
			if (typeof tool === 'string' && tool.length > 0) {
				rules.push({ action: 'tool', resource: tool, effect: 'allow' });
			}
		}
	} else if (config.tools && typeof config.tools === 'object') {
		for (const [tool, enabled] of Object.entries(
			config.tools as Record<string, unknown>,
		)) {
			if (enabled === false) continue;
			if (tool.length > 0)
				rules.push({ action: 'tool', resource: tool, effect: 'allow' });
		}
	}
	if (rules.length > 0) info.permissions = rules;
	return info;
}

/** Expand a v1 TUI template for a v2 command execution. */
export function expandV1Template(
	template: string,
	argumentsText: string,
): string {
	return template.replaceAll('$ARGUMENTS', argumentsText).trim();
}

/**
 * Extract the dispatched prompt text from a command handler's spliced parts.
 * Every part carrying a non-whitespace string `text` and either no `type` or
 * the `text` type contributes (a stricter producer contract — exactly one
 * `{type:'text', text}` part — must survive verbatim; looser shapes degrade
 * gracefully instead of truncating: contributions are joined with a blank
 * line, mirroring the v1 host that submits the whole parts array). Entries
 * that are malformed, foreign-typed (e.g. `tool_result`), or
 * whitespace-only are skipped, never thrown on.
 */
function extractDispatchedPromptText(parts: unknown[]): string | null {
	const texts: string[] = [];
	for (const part of parts) {
		if (!part || typeof part !== 'object') continue;
		const typed = part as { type?: unknown; text?: unknown };
		if (typed.type !== undefined && typed.type !== 'text') continue;
		if (typeof typed.text !== 'string') continue;
		if (typed.text.trim().length === 0) continue;
		texts.push(typed.text);
	}
	if (texts.length === 0) return null;
	return texts.join('\n\n');
}

/**
 * Build the fallback prompt text for an execute whose dispatch produced no
 * handler output. Templates carrying `$ARGUMENTS` expand as before; FIXED
 * templates (no placeholder) append the typed arguments, so a degraded
 * fallback does not silently drop what the user typed (review PRR-003a).
 */
function buildFallbackPromptText(
	template: string,
	argumentsText: string,
): string {
	if (template.includes('$ARGUMENTS')) {
		return expandV1Template(template, argumentsText);
	}
	const trimmed = argumentsText.trim();
	return trimmed.length > 0 ? `${template} ${trimmed}` : template;
}

/**
 * Native /swarm command dispatch for the v2 execute path (#3169 Phase 4).
 *
 * Invokes the shared v1 command handler (`command.execute.before` on the
 * hooks object — the same safeHook-wrapped handler the v1 host runs for a
 * human-typed command: registry resolution, policy refusals, help/not-found,
 * real handler execution, and the canonical output envelope) and submits the
 * handler-produced prompt through the v2 session prompt surface.
 *
 * Fallback arms: an absent hook, an empty parts result, or a swallowed
 * handler error submits the expanded template exactly as the pre-#3169
 * bridge did (production wraps the handler in safeHook, so a handler throw
 * surfaces as empty parts — the same net degradation). A dispatch TIMEOUT
 * submits a distinct bounded notice instead — never the raw template, so
 * the model is not prompted to re-attempt a command that may still be
 * completing in the background.
 *
 * Human provenance: this path is reachable only through the host's
 * command-execute surface. The live A/B on 2.0.26 (issue #3169 comments
 * 6083674508 / 6106407764) verified that a human-typed TUI command reaches
 * this path and that headless prompt text is received as text, not routed as
 * a command; whether ANY model-reachable surface (e.g. the vendored
 * `SessionDomain.command`) can invoke `execute` is open live-verification
 * item (b) on #3169, disclosed in the release fragment — the human-only
 * property rests on that host contract, not on a check in this seam (which
 * has no provenance field to test).
 */
async function deferredV2ExecuteSwarmCommand(
	hooks: V1HooksSubset,
	key: string,
	template: string,
	ctx: V2PluginContext,
	invocation: V2CommandInvocation,
): Promise<void> {
	// The prompt-surface check precedes dispatch: a host without the session
	// prompt surface must not run the registry handler (side-effect-free
	// no-op, the pre-#3169 arm).
	const prompt = ctx.session?.prompt;
	if (typeof prompt !== 'function') {
		log('v2 command executed without a session prompt surface', { name: key });
		return;
	}
	let dispatched: string | null = null;
	// Coerce once: a non-string prompt.text (host contract violation) must
	// degrade to empty arguments, not throw out of `execute`.
	const rawArguments = invocation?.prompt?.text;
	const argumentsText = typeof rawArguments === 'string' ? rawArguments : '';
	const hook = hooks['command.execute.before'];
	if (typeof hook === 'function') {
		const output: { parts: unknown[] } = { parts: [] };
		const dispatchTimeoutError = new Error(
			`[opencode-swarm] v2: command ${key} dispatch exceeded budget`,
		);
		try {
			await withTimeout(
				Promise.resolve(
					hook(
						{
							command: key,
							sessionID: invocation.sessionID,
							arguments: argumentsText,
						},
						output,
					),
				),
				_internals.dispatchTimeoutMs,
				dispatchTimeoutError,
			);
			dispatched = extractDispatchedPromptText(output.parts);
		} catch (err) {
			if (err === dispatchTimeoutError) {
				const budgetSeconds = _internals.dispatchTimeoutMs / 1000;
				try {
					await withTimeout(
						Promise.resolve(
							prompt({
								sessionID: invocation.sessionID,
								text:
									`[opencode-swarm] v2: command ${key} dispatch exceeded its ` +
									`${budgetSeconds}s budget; the command may still be completing ` +
									`in the background — check its status before re-running.`,
							}),
						),
						V2_REGISTRATION_TIMEOUT_MS,
						new Error(
							`[opencode-swarm] v2: command ${key} prompt exceeded budget`,
						),
					);
				} catch (noticeErr) {
					// A failed notice submission must not reject `execute` after the
					// handler already ran (review PRR-005): degrade to a log.
					log('v2 command timeout notice submission failed', {
						name: key,
						error:
							noticeErr instanceof Error
								? noticeErr.message
								: String(noticeErr),
					});
				}
				return;
			}
			log('v2 command dispatch failed (falling back to template)', {
				name: key,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	const text = dispatched ?? buildFallbackPromptText(template, argumentsText);
	// 2.0.26 SessionApi shape: one object input carrying
	// sessionID + text (issue #3169; the published surface has
	// been object-input since at least 2.0.20). A rejection here degrades to
	// a log rather than rejecting `execute` — the handler's side effects are
	// already done and the host must not observe a failed command for a
	// submission-surface error (review PRR-005).
	try {
		await withTimeout(
			Promise.resolve(prompt({ sessionID: invocation.sessionID, text })),
			V2_REGISTRATION_TIMEOUT_MS,
			new Error(`[opencode-swarm] v2: command ${key} prompt exceeded budget`),
		);
	} catch (err) {
		log('v2 command prompt submission failed', {
			name: key,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/** Register agents + commands via the synthetic config-hook run. */
export async function registerV2AgentsAndCommands(
	ctx: V2PluginContext,
	hooks: V1HooksSubset,
	directory: string,
	registrations: V2Registration[],
): Promise<void> {
	if (typeof hooks.config !== 'function') return;

	// The v1 config hook mutates this object in place — the shared builder.
	const syntheticConfig: Record<string, unknown> = {};
	await withTimeout(
		Promise.resolve(hooks.config(syntheticConfig)),
		V2_REGISTRATION_TIMEOUT_MS,
		new Error('[opencode-swarm] v2: synthetic config-hook run exceeded budget'),
	);

	const agentTable = (syntheticConfig.agent ?? {}) as Record<
		string,
		V1AgentConfigLike
	>;
	const commandTable = (syntheticConfig.command ?? {}) as Record<
		string,
		{ template?: unknown; description?: unknown }
	>;

	const agentRegistration = await withTimeout(
		ctx.agent.transform((editor: V2AgentEditor) => {
			for (const [name, config] of Object.entries(agentTable)) {
				if (!config || typeof config !== 'object') continue;
				if (config.disable === true) {
					// v1 auto-select disables competing built-ins by flag; v2 removes.
					editor.remove(name);
					continue;
				}
				const mapped = mapV1AgentToV2(name, config);
				// update(id, fn) is the v2 AgentEditor's create-or-update primitive.
				editor.update(name, (agent: V2AgentInfo) => {
					Object.assign(agent, mapped);
				});
			}
		}),
		V2_REGISTRATION_TIMEOUT_MS,
		new Error('[opencode-swarm] v2: agent transform exceeded budget'),
	);
	registrations.push(agentRegistration);

	const commandRegistration = await withTimeout(
		ctx.command.transform(
			(editor: { add(definition: V2CommandDefinition): void }) => {
				for (const [key, entry] of Object.entries(commandTable)) {
					if (!entry || typeof entry !== 'object') continue;
					const template =
						typeof entry.template === 'string' ? entry.template : undefined;
					if (template === undefined) continue;
					const definition: V2CommandDefinition = {
						name: key,
						description:
							typeof entry.description === 'string'
								? entry.description
								: undefined,
						// #3169 Phase 4: native dispatch through the shared v1
						// command handler, with the raw-template bridge as the
						// explicit fallback. Deliberately NOT an async arrow:
						// every await lives in the deferred*-named helper so the
						// C6 no-bare-awaits scan (dual-shape-parity) stays clean —
						// the scanner does not track object-literal method names.
						execute: (invocation) =>
							deferredV2ExecuteSwarmCommand(
								hooks,
								key,
								template,
								ctx,
								invocation,
							),
					};
					editor.add(definition);
				}
			},
		),
		V2_REGISTRATION_TIMEOUT_MS,
		new Error('[opencode-swarm] v2: command transform exceeded budget'),
	);
	registrations.push(commandRegistration);

	log('v2 agents + commands registered', {
		directory,
		agents: Object.keys(agentTable).length,
		commands: Object.keys(commandTable).length,
	});
}
