/**
 * v2 lifecycle hook adapters — tool execute.before/after, session compaction,
 * session prompt (issue #3004 / #2910).
 *
 * Each adapter wraps the SAME v1 handler functions with payload translation:
 *
 *   - `tool.execute.before`: v2 `{tool, sessionID, agent, messageID, id,
 *     input}` → v1 `{tool, sessionID, callID, agent}` + mutable output
 *     `{args}`; the v1 chain's `output.args` mutation is applied back onto
 *     `event.input` in place.
 *   - `tool.execute.after`: v1 `{title, output, metadata}` mutable output is
 *     fed a best-effort translation of the v2 completed/error result.
 *     (v2 has no title surface; the translation targets the fields the v1
 *     toolAfter chain reads.)
 *   - `compaction`: translated session/model identity; the v1 customizer's
 *     directive output has no v1→v2 mapping yet — the turn-generation advance
 *     and the customizer still run (inventory row).
 *   - `prompt`: the v1 `chat.message` chain (model fallback preflight,
 *     delegation ledger, cache-cohort seeding) runs against a translated
 *     envelope. The #2989 chat-boundary model override writes
 *     `output.message.model`, which the v2 SessionPrompt has no field for —
 *     v1-only for now (inventory row).
 *
 * Denial semantics: a v1 hook throw propagates as the v2 hook error
 * (fail-closed preserved; documented v2 delta in the inventory).
 */

import { normalizeToolNameLowerCase } from '../../hooks/normalize-tool-name';
import { log } from '../../utils';
import { withTimeout } from '../../utils/timeout';
import { normalizeV2AgentRef, seedV1SessionState } from './setup';
import type {
	V1HooksSubset,
	V2PluginContext,
	V2Registration,
	V2SessionCompactionEvent,
	V2SessionPromptEvent,
	V2ToolHookInput,
} from './types';

const V2_HOOK_TIMEOUT_MS = 60_000;

/**
 * v2 delegation-tool identity translation (issue #3169 Phase 1 / #3165 §D).
 *
 * OpenCode 2 renamed the native subagent tool: v1 `task` (args `subagent_type`,
 * `task_id`) became v2 `subagent` (args `agent`, `sessionID`), and its result
 * text is wrapped as `<subagent sessionID="…" state="…">…</subagent>` instead
 * of the v1 `<task id="…" state="…"><task_result>…</task_result></task>`
 * envelope (live-verified on @opencode/cli 2.0.26 — issue #3169 Phase 0). The
 * v1 chain (delegation gate, ack collectors, residue commit) recognizes only
 * the v1 names, so the adapter translates at this boundary and Epic/gate code
 * stays untouched.
 */

/** Mirrors `isTaskToolId`'s shape (dotted SDK form OR normalized base name). */
function isV2SubagentToolId(toolName: string | null | undefined): boolean {
	if (!toolName) return false;
	if (toolName.includes('.')) {
		return /^tool\.[^.:]+\.subagent$/i.test(toolName);
	}
	return normalizeToolNameLowerCase(toolName) === 'subagent';
}

/**
 * Any recognized v2 subagent id (bare, namespace-prefixed, or dotted) is handed
 * to the v1 chain as the bare v1 id `task`. The v1 host reports the native tool
 * bare, and six collectors compare the name literally
 * (`tool === 'Task' || tool === 'task'`), so a prefixed/dotted output would
 * keep them dead — every recognized form collapses to `task`.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** v2 arg names → v1 arg names (`agent`→`subagent_type`, `sessionID`→`task_id`). */
function mapV2SubagentArgsToV1(input: unknown): unknown {
	if (!isPlainObject(input)) return input;
	const mapped: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		if (key === 'agent') mapped.subagent_type = value;
		else if (key === 'sessionID') mapped.task_id = value;
		else mapped[key] = value;
	}
	return mapped;
}

/** v1 arg names → v2 arg names (inverse of the forward map). */
function mapV1TaskArgsToV2(args: unknown): unknown {
	if (!isPlainObject(args)) return args;
	const mapped: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		if (key === 'subagent_type') mapped.agent = value;
		else if (key === 'task_id') mapped.sessionID = value;
		else mapped[key] = value;
	}
	return mapped;
}

/**
 * Anchored to the opening tag only — tolerant of arbitrary body and of
 * additional trailing attributes (the completion pump renders a
 * three-attribute wrapper; session/subagent-completion.ts on host 2.0.26) —
 * mirroring `TASK_ENVELOPE_RE`'s discipline in `src/background/task-envelope.ts`.
 * `state` stays constrained so unrelated `<subagent …>` text cannot masquerade
 * as a wrapper.
 */
const V2_SUBAGENT_WRAPPER_RE =
	/<subagent\s+sessionID="([^"]+)"\s+state="(running|completed|error|cancelled|canceled)"[^>]*>/;

/** Matches `MAX_TASK_ENVELOPE_TEXT_CHARS` in task-envelope.ts (same bound class). */
const MAX_V2_WRAPPER_INNER_CHARS = 20_000;

interface V2SubagentWrapper {
	sessionID: string;
	state: 'running' | 'completed' | 'error' | 'cancelled';
	inner: string;
}

/** Parse the v2 result-text wrapper; null when the text is not the wrapper. */
function parseV2SubagentWrapper(content: unknown): V2SubagentWrapper | null {
	if (typeof content !== 'string') return null;
	const match = content.match(V2_SUBAGENT_WRAPPER_RE);
	if (!match) return null;
	const sessionID = match[1];
	// Charset guard: the sessionID is interpolated into the re-rendered v1
	// envelope attributes verbatim, so markup characters would corrupt the
	// envelope shape the v1 parser reads.
	if (sessionID.includes('<') || sessionID.includes('>')) return null;
	const rawState = match[2];
	// inner is everything after the (tolerant) opening tag; strip a trailing
	// closing tag so canonical wrappers re-render byte-equivalent envelopes
	// to v1, while truncated/drifted bodies still parse.
	const matchStart = match.index ?? 0;
	const inner = content
		.slice(matchStart + match[0].length)
		.replace(/\s*<\/subagent>\s*$/, '');
	return {
		sessionID,
		state:
			rawState === 'canceled'
				? 'cancelled'
				: (rawState as V2SubagentWrapper['state']),
		inner,
	};
}

/**
 * Matches the tag sequences `parseTaskEnvelope` gives structural meaning
 * (result/error/summary open+close). Inside the re-rendered envelope these
 * must only exist where WE put them, or the non-greedy extraction truncates
 * and the task_error-over-result preference can be hijacked by crafted inner
 * text. Neutralized forms stay readable (display-only corruption of the tag
 * token; model content preserved verbatim otherwise).
 */
const V2_WRAPPER_STRUCTURAL_TAG_RE = /<\/?(?:task_result|task_error|summary)>/g;

/**
 * Re-render the v2 wrapper as the v1 task envelope so every tool.execute.after
 * consumer (`parseTaskEnvelope`, `extractDispatchIds`, receipts, residue)
 * keeps working unchanged. Non-wrapper text passes through as-is; never throws
 * (same discipline as `src/background/task-envelope.ts`).
 */
function renderV1TaskEnvelopeFromV2(wrapper: V2SubagentWrapper): string {
	// Length-bounded at the render site: the raw inner is otherwise copied
	// ~3x (parse match, this template, the downstream envelope re-parse).
	let inner = wrapper.inner;
	if (inner.length > MAX_V2_WRAPPER_INNER_CHARS) {
		const omitted = inner.length - MAX_V2_WRAPPER_INNER_CHARS;
		inner = `${inner.slice(0, MAX_V2_WRAPPER_INNER_CHARS)}\n[... ${omitted} chars truncated by v2 task translation ...]`;
	}
	inner = inner.replace(V2_WRAPPER_STRUCTURAL_TAG_RE, (tag) =>
		tag.replace('<', '<\\'),
	);
	return `<task id="${wrapper.sessionID}" state="${wrapper.state}"><task_result>${inner}</task_result></task>`;
}

/** adapter for tool.execute.before */
async function onV2ToolBefore(
	event: V2ToolHookInput,
	hooks: V1HooksSubset,
	directory: string,
): Promise<void> {
	const handler = hooks['tool.execute.before'];
	if (typeof handler !== 'function') return;
	seedV1SessionState(event.sessionID, event.agent, directory);
	const isSubagent = isV2SubagentToolId(event.tool);
	const output = {
		args: isSubagent ? mapV2SubagentArgsToV1(event.input) : event.input,
	};
	await withTimeout(
		Promise.resolve(
			handler(
				{
					tool: isSubagent ? 'task' : event.tool,
					sessionID: event.sessionID,
					callID: event.id,
					agent: normalizeV2AgentRef(event.agent),
					messageID: event.messageID,
				},
				output,
			),
		),
		V2_HOOK_TIMEOUT_MS,
		new Error('[opencode-swarm] v2: tool.execute.before exceeded budget'),
	);
	if (isSubagent) {
		// Write back IN PLACE onto the retained original input object: the v2
		// host may hold its own reference to the event payload (the v1
		// invariant-10 class), so reassignment could be invisible to it.
		const mapped = mapV1TaskArgsToV2(output.args);
		if (isPlainObject(event.input) && isPlainObject(mapped)) {
			for (const key of Object.keys(event.input)) {
				delete (event.input as Record<string, unknown>)[key];
			}
			Object.assign(event.input as Record<string, unknown>, mapped);
		}
	} else {
		event.input = output.args;
	}
}

/** adapter for tool.execute.after */
async function onV2ToolAfter(
	event: V2ToolHookInput,
	hooks: V1HooksSubset,
	directory: string,
): Promise<void> {
	const handler = hooks['tool.execute.after'];
	if (typeof handler !== 'function') return;
	seedV1SessionState(event.sessionID, event.agent, directory);
	const isSubagent = isV2SubagentToolId(event.tool);
	const output = translateV2ResultToV1Output(event, isSubagent);
	await withTimeout(
		Promise.resolve(
			handler(
				{
					tool: isSubagent ? 'task' : event.tool,
					sessionID: event.sessionID,
					callID: event.id,
					agent: normalizeV2AgentRef(event.agent),
					messageID: event.messageID,
					// The v1 after chain reads `input.args` as the authoritative
					// arg source (delegation-gate.ts); the adapter previously
					// omitted it entirely on v2 (fidelity gap closed by #3169).
					...(isSubagent ? { args: mapV2SubagentArgsToV1(event.input) } : {}),
				},
				output,
			),
		),
		V2_HOOK_TIMEOUT_MS,
		new Error('[opencode-swarm] v2: tool.execute.after exceeded budget'),
	).catch((err: unknown) => {
		log('v2 tool.execute.after failed (non-fatal)', {
			tool: event.tool,
			error: err instanceof Error ? err.message : String(err),
		});
	});
}

function translateV2ResultToV1Output(
	event: V2ToolHookInput,
	isSubagent: boolean,
): {
	title: string;
	state: 'running' | 'error' | 'completed' | 'cancelled';
	output: string;
	metadata: Record<string, unknown>;
} {
	if (event.status === 'error') {
		const message =
			event.error && typeof event.error.message === 'string'
				? event.error.message
				: 'tool error';
		// Terminal precedence on BOTH channels (#3169 review round 3): an
		// error result keeps the error-message text — no envelope re-render,
		// so a stale running wrapper inside an error result can never be
		// re-rendered into a correlatable running envelope for the
		// text-parsing consumers (task-envelope.ts extractDispatchIds).
		return { title: 'error', state: 'error', output: message, metadata: {} };
	}
	const result = event.result;
	const content =
		typeof result?.content === 'string'
			? result.content
			: Array.isArray(result?.content)
				? (result?.content as Array<{ type: string; text?: string }>)
						.filter((p) => p.type === 'text' && typeof p.text === 'string')
						.map((p) => p.text)
						.join('\n')
				: '';
	if (isSubagent) {
		const wrapper = parseV2SubagentWrapper(content);
		if (wrapper) {
			// 'cancelled' keeps its own structured state (v1 parity): the
			// spawn-failure circuit counts only state === 'error'
			// (index.ts), and delegation-gate's terminal-failure predicate
			// already treats 'cancelled' as the distinct neutral terminal.
			const structuredState: 'running' | 'completed' | 'error' | 'cancelled' =
				wrapper.state === 'running'
					? 'running'
					: wrapper.state === 'completed'
						? 'completed'
						: wrapper.state === 'error'
							? 'error'
							: 'cancelled';
			return {
				title: '',
				state: structuredState,
				output: renderV1TaskEnvelopeFromV2(wrapper),
				metadata: (result?.metadata as Record<string, unknown>) ?? {},
			};
		}
		if (content.includes('<subagent')) {
			// The text looks like the wrapper but did not parse (attribute
			// drift). Bounded debug note — never chat-visible noise — instead
			// of a silent completed classification.
			log('v2 subagent wrapper not recognized; passing result text through', {
				chars: content.length,
			});
		}
	}
	return {
		title: '',
		state: 'completed',
		output: content,
		metadata: (result?.metadata as Record<string, unknown>) ?? {},
	};
}

/** adapter for session compaction */
async function onV2Compaction(
	event: V2SessionCompactionEvent,
	hooks: V1HooksSubset,
	directory: string,
): Promise<void> {
	const handler = hooks['experimental.session.compacting'];
	if (typeof handler !== 'function') return;
	seedV1SessionState(event.sessionID, event.agent, directory);
	const model = event.model as { id?: string; providerID?: string } | undefined;
	const output: Record<string, unknown> = {};
	await withTimeout(
		Promise.resolve(
			handler(
				{
					sessionID: event.sessionID,
					providerID:
						typeof model?.providerID === 'string'
							? model.providerID
							: 'unknown',
					modelID: typeof model?.id === 'string' ? model.id : 'unknown',
				},
				output,
			),
		),
		V2_HOOK_TIMEOUT_MS,
		new Error('[opencode-swarm] v2: compaction hook exceeded budget'),
	).catch((err: unknown) => {
		log('v2 compaction hook failed (non-fatal)', {
			error: err instanceof Error ? err.message : String(err),
		});
	});
	// The v1 customizer's directive fields have no v2 mapping yet (inventory row).
}

/** adapter for session prompt (v1 chat.message chain) */
async function onV2Prompt(
	event: V2SessionPromptEvent,
	hooks: V1HooksSubset,
): Promise<void> {
	const handler = hooks['chat.message'];
	if (typeof handler !== 'function') return;
	const text = event.prompt?.text ?? '';
	const message = {
		id: event.messageID,
		role: 'user',
		sessionID: event.sessionID,
	};
	const parts = [{ type: 'text', text }];
	const input = {
		sessionID: event.sessionID,
		message: { ...message },
		parts: [...parts],
	};
	const output = { message: { ...message }, parts: [...parts] };
	await withTimeout(
		Promise.resolve(handler(input, output)),
		V2_HOOK_TIMEOUT_MS,
		new Error('[opencode-swarm] v2: prompt hook exceeded budget'),
	).catch((err: unknown) => {
		log('v2 prompt (chat.message) hook failed (non-fatal)', {
			error: err instanceof Error ? err.message : String(err),
		});
	});
	// The v1 chain mutates output.message/output.parts in place; the v2
	// SessionPrompt's own fields stay authoritative (model override is
	// v1-only until an equivalent v2 surface is confirmed — inventory row).
	if (typeof event.prompt === 'object' && event.prompt !== null) {
		const rewritten = (
			output.parts as Array<{ type: string; text?: string }>
		).find((p) => p.type === 'text' && typeof p.text === 'string');
		if (
			rewritten &&
			typeof rewritten.text === 'string' &&
			rewritten.text !== text
		) {
			event.prompt.text = rewritten.text;
		}
	}
}

/** Register the tool hooks (execute.before/after). */
export async function registerV2ToolHooks(
	ctx: V2PluginContext,
	hooks: V1HooksSubset,
	directory: string,
	registrations: V2Registration[],
): Promise<void> {
	const before = await withTimeout(
		ctx.tool.hook('execute.before', async (event: unknown) => {
			return onV2ToolBefore(event as V2ToolHookInput, hooks, directory);
		}),
		V2_HOOK_TIMEOUT_MS,
		new Error(
			'[opencode-swarm] v2: execute.before registration exceeded budget',
		),
	);
	registrations.push(before);
	const after = await withTimeout(
		ctx.tool.hook('execute.after', async (event: unknown) => {
			return onV2ToolAfter(event as V2ToolHookInput, hooks, directory);
		}),
		V2_HOOK_TIMEOUT_MS,
		new Error(
			'[opencode-swarm] v2: execute.after registration exceeded budget',
		),
	);
	registrations.push(after);
}

/** Register the compaction + prompt session hooks. */
export async function registerV2SessionHooks(
	ctx: V2PluginContext,
	hooks: V1HooksSubset,
	directory: string,
	registrations: V2Registration[],
): Promise<void> {
	const compaction = await withTimeout(
		ctx.session.hook('compaction', (async (event: unknown) => {
			return onV2Compaction(
				event as V2SessionCompactionEvent,
				hooks,
				directory,
			);
		}) as never),
		V2_HOOK_TIMEOUT_MS,
		new Error('[opencode-swarm] v2: compaction registration exceeded budget'),
	);
	registrations.push(compaction);
	const prompt = await withTimeout(
		ctx.session.hook('prompt', (async (event: unknown) => {
			return onV2Prompt(event as V2SessionPromptEvent, hooks);
		}) as never),
		V2_HOOK_TIMEOUT_MS,
		new Error('[opencode-swarm] v2: prompt registration exceeded budget'),
	);
	registrations.push(prompt);
}
