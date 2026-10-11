/**
 * v2 session client shim — issue #3169 Phase 2.
 *
 * A narrow `OpencodeClient` subset implementing exactly the v1 session surface
 * Epic's dispatch paths use (`session.create/prompt/abort/delete` plus `get`,
 * which verified teardown requires), backed by the v2 host's `ctx.session`
 * domain. Installed as the synthetic v1 PluginInput's `client` field by
 * `setup.ts`, it flows through the shared init core's single client write site
 * into `swarmState.opencodeClient` and every init-path `ctx.client` consumer —
 * the tracking issue's Decision 2 (a client subset instead of v2 branches
 * spread through consumers).
 *
 * Translation contract (per the issue §4 gap table and the Phase 0 live
 * findings on @opencode/cli 2.0.26):
 *
 *   - `create({body:{parentID,title}, query:{directory}})` validates placement
 *     BEFORE creating anything: v2 child sessions inherit the parent's
 *     directory and ignore the requested one (Phase 0 C1 catch), so a divergent
 *     or unverifiable placement fails closed with a typed `{data: null,
 *     error}` result — routing worktree isolation to its existing degradation
 *     path instead of silently running a "lane" session in the project root.
 *     A passing precheck mints a placeholder id; the real v2 session is
 *     created at PROMPT time, when the v1 prompt body supplies the create-time
 *     options (agent/model/permissions) the published `SessionCreateInput`
 *     expects (issue R2: one session per dispatch contains the per-session
 *     shift).
 *   - `prompt({path:{id}, body:{agent,model?,system?,tools,parts}, signal?})`
 *     emulates the v1 BLOCKING call: real create (carrying agent/model and the
 *     read-only denial map as `effect:'deny'` permissions) → one sessionID-
 *     scoped `context` hook that replaces `event.system` (fence-aware: parts
 *     carrying the `<swarm_system_directive` provenance fence survive, per
 *     #2526) and deletes denied keys from `event.tools` → `prompt` → bounded
 *     `wait` → `context()` translated into the v1 `{data:{info,parts}}`
 *     envelope so `dispatchEphemeralAgent` and `readProviderMessageError`
 *     work unchanged. A prompt addressed to a non-placeholder (real) session
 *     id takes a direct path without re-creating — the pr-event-delivery wake
 *     prompt shape.
 *   - Provider failures are EVENT-SOURCED on v2 (Phase 0 C4: no error text in
 *     `context()`), so the event pump records `session.error` /
 *     `session.execution.failed` payloads here (`recordV2SessionErrorFromEnvelope`,
 *     called pump-side beside `seedSessionIdentityFromEnvelope`) and the
 *     translation surfaces them as the v1 `info.error` shape. A failed outcome
 *     without recorded detail yields a bounded `provider.unknown` error
 *     instead of a silent empty success.
 *   - `abort` maps to `interrupt`, `delete` to `remove`, `get` to the v2 get
 *     (unresolved placeholders read as `{data: null}` — never prompted means
 *     gone, satisfying `teardownEphemeralSessionVerified`).
 *
 * Deferred-work marker: NONE. The unverified live-host behaviors this design
 * rests on are recorded as deferrals in the trace (context-hook firing for
 * plugin-created sessions, permission vocabulary honor, `context()` entry
 * shapes, `wait` on failed prompts, `get(parent).location` availability) with
 * the owning follow-up on #3169.
 *
 * C6 await convention: every `await` lives inside a `deferredV2Session*`
 * function declaration or `const deferredV2SessionX = async (` binding — the
 * dual-shape-parity scan's function tracker does not recognize object-literal
 * method properties, so the client object's methods never await directly.
 */

import type { OpencodeClient } from '@opencode-ai/sdk';
import { canonicalRootKeyLexical } from '../../utils/canonical-root';
import { log } from '../../utils/logger';
import type {
	V2EventEnvelope,
	V2PluginContext,
	V2Registration,
	V2SessionContextEvent,
	V2SessionPermission,
} from './types';

/** The #2526 provenance fence opener — fenced system parts survive replacement. */
const SYSTEM_DIRECTIVE_FENCE_OPEN = '<swarm_system_directive';

/** Bounded placeholder registry (invariant 8): one live placeholder per dispatch. */
const MAX_PLACEHOLDER_SESSIONS = 64;
/** Bounded event-sourced error store (invariant 8). */
const MAX_RECORDED_SESSION_ERRORS = 128;
/** Bounded recheck for pump lag before synthesizing a no-detail failure. */
const ERROR_RECHECK_ATTEMPTS = 3;
const ERROR_RECHECK_DELAY_MS = 50;
/**
 * Default wait cap for callers that pass no AbortSignal. v1 `session.prompt`
 * blocks until completion; signal-carrying callers (the dispatcher, lean
 * turbo) keep that exact semantics through their own signal, so the cap only
 * backstops the signal-less wake-prompt callers.
 */
const SIGNAL_LESS_WAIT_CAP_MS = 10 * 60 * 1000;

interface PlaceholderRecord {
	parentID?: string;
	title?: string;
	directory: string;
	realId?: string;
	/** Set synchronously when a prompt on this placeholder starts. */
	promptStarted?: boolean;
	/**
	 * #3169 Phase 2 review round 1: the caller's teardown (abort/delete) can
	 * arrive while the prompt is still in flight — before `realId` is bound.
	 * Those calls park these flags and the prompt's finally honors them once
	 * the real id exists, so a timed-out dispatch still cleans up its host
	 * session.
	 */
	abortPending?: boolean;
	deletePending?: boolean;
}

const placeholderSessions = new Map<string, PlaceholderRecord>();
const sessionErrors = new Map<string, unknown>();
let placeholderCounter = 0;

function rememberPlaceholder(id: string, record: PlaceholderRecord): void {
	placeholderSessions.set(id, record);
	while (placeholderSessions.size > MAX_PLACEHOLDER_SESSIONS) {
		const oldest = placeholderSessions.keys().next().value;
		if (oldest === undefined) break;
		placeholderSessions.delete(oldest);
	}
}

function rememberSessionError(sessionId: string, error: unknown): void {
	sessionErrors.set(sessionId, error);
	while (sessionErrors.size > MAX_RECORDED_SESSION_ERRORS) {
		const oldest = sessionErrors.keys().next().value;
		if (oldest === undefined) break;
		sessionErrors.delete(oldest);
	}
}

/**
 * Record a `session.error` / `session.execution.failed` envelope's error
 * payload for the shim's result translation. SYNC by contract — the event pump
 * calls it inline in its iteration loop. Accepts the same dual payload dialect
 * `mapV2EventToV1` accepts (live `data`, SDK `properties`).
 */
export function recordV2SessionErrorFromEnvelope(
	envelope: V2EventEnvelope,
): void {
	const type = typeof envelope?.type === 'string' ? envelope.type : undefined;
	if (type !== 'session.error' && type !== 'session.execution.failed') return;
	const payload =
		(envelope as { data?: Record<string, unknown> }).data ??
		(envelope as { properties?: Record<string, unknown> }).properties ??
		{};
	const sessionID =
		typeof payload.sessionID === 'string' ? payload.sessionID : undefined;
	const error = payload.error;
	if (sessionID !== undefined && error !== undefined) {
		rememberSessionError(sessionID, error);
	}
}

/** Drop all shim-held state (v2 cleanup path; bounded residue documented in the trace). */
export function clearV2SessionClientState(): void {
	placeholderSessions.clear();
	sessionErrors.clear();
}

/**
 * Map a v1 read-only denial map onto v2 create-time permission entries.
 * Fail-closed shape: only `effect: 'deny'` entries are ever produced.
 */
export function readOnlyToolsToV2Permissions(
	tools: Readonly<Record<string, false>> | undefined,
): V2SessionPermission[] {
	if (!tools || typeof tools !== 'object') return [];
	const permissions: V2SessionPermission[] = [];
	for (const resource of Object.keys(tools)) {
		if (resource.length === 0) continue;
		permissions.push({ action: 'tool', resource, effect: 'deny' });
	}
	return permissions;
}

/** Filesystem-free directory equality (win32 separator + case tolerant). */
function sameDirectoryLexical(a: string, b: string): boolean {
	return canonicalRootKeyLexical(a) === canonicalRootKeyLexical(b);
}

function isAssistantEntry(entry: unknown): boolean {
	if (!entry || typeof entry !== 'object') return false;
	const record = entry as { role?: unknown; type?: unknown };
	if (record.role === 'assistant') return true;
	return typeof record.type === 'string' && record.type.includes('assistant');
}

function isUserEntry(entry: unknown): boolean {
	if (!entry || typeof entry !== 'object') return false;
	const record = entry as { role?: unknown; type?: unknown };
	if (record.role === 'user') return true;
	return typeof record.type === 'string' && record.type.includes('user');
}

function entryText(entry: unknown): string | undefined {
	if (!entry || typeof entry !== 'object') return undefined;
	const record = entry as {
		text?: unknown;
		content?: unknown;
		parts?: unknown;
	};
	if (typeof record.text === 'string') return record.text;
	const blocks: unknown[] | undefined = Array.isArray(record.content)
		? record.content
		: Array.isArray(record.parts)
			? record.parts
			: undefined;
	if (!blocks) return undefined;
	const texts: string[] = [];
	for (const block of blocks) {
		if (
			block &&
			typeof block === 'object' &&
			(block as { type?: unknown }).type === 'text' &&
			typeof (block as { text?: unknown }).text === 'string'
		) {
			texts.push((block as { text: string }).text);
		}
	}
	return texts.length > 0 ? texts.join('\n') : undefined;
}

function entryModelIds(entry: unknown): {
	providerID?: string;
	modelID?: string;
} {
	if (!entry || typeof entry !== 'object') return {};
	const record = entry as {
		model?: { id?: unknown; providerID?: unknown };
		modelID?: unknown;
		providerID?: unknown;
	};
	const providerID =
		typeof record.model?.providerID === 'string'
			? record.model.providerID
			: typeof record.providerID === 'string'
				? record.providerID
				: undefined;
	const modelID =
		typeof record.model?.id === 'string'
			? record.model.id
			: typeof record.modelID === 'string'
				? record.modelID
				: undefined;
	return { providerID, modelID };
}

function idleOutcome(entries: unknown[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (!entry || typeof entry !== 'object') continue;
		const record = entry as { type?: unknown; outcome?: unknown };
		if (record.type !== 'idle') continue;
		return typeof record.outcome === 'string' ? record.outcome : undefined;
	}
	return undefined;
}

function recordedErrorToInfoError(error: unknown): {
	name: string;
	data: { message: string; statusCode?: number };
} {
	if (error && typeof error === 'object') {
		const record = error as {
			name?: unknown;
			message?: unknown;
			status?: unknown;
			statusCode?: unknown;
			data?: { message?: unknown; statusCode?: unknown };
		};
		const message =
			typeof record.data?.message === 'string' && record.data.message.length > 0
				? record.data.message
				: typeof record.message === 'string' && record.message.length > 0
					? record.message
					: 'no message';
		const statusCodeValue =
			typeof record.data?.statusCode === 'number' &&
			Number.isFinite(record.data.statusCode)
				? record.data.statusCode
				: typeof record.statusCode === 'number' &&
						Number.isFinite(record.statusCode)
					? record.statusCode
					: typeof record.status === 'number' && Number.isFinite(record.status)
						? record.status
						: undefined;
		return {
			name:
				typeof record.name === 'string' && record.name.length > 0
					? record.name.slice(0, 64)
					: 'ProviderError',
			data: {
				message,
				...(statusCodeValue === undefined
					? {}
					: { statusCode: statusCodeValue }),
			},
		};
	}
	return {
		name: 'ProviderError',
		data: {
			message: 'v2 session failed without recorded error detail',
		},
	};
}

interface TranslatedPromptData {
	info: Record<string, unknown>;
	parts: Array<{ type: 'text'; text: string }>;
}

interface ContextClassification {
	outcome: string | undefined;
	texts: string[];
	model: Record<string, unknown>;
	/** Only the paths where a recorded event error decides the verdict. */
	needsErrorLookup: boolean;
}

/**
 * Classify a `context()` entry list per the pinned translation matrix (trace
 * 05 plan, F1/F1-R2/F5/F4-R2): an explicit non-failed idle outcome succeeds
 * EVEN WITH ZERO assistant text (empty parts keep the bash-retry
 * `providerRefused` arm-1 signal `completed`+empty-text); only `failed`, a
 * recorded event error, or a textless turn with no idle marker take the error
 * path; assistant entries require an explicit role marker and only the
 * entries AFTER the last user-role entry (the final turn) join.
 */
function classifyContextEntries(entries: unknown[]): ContextClassification {
	const lastUserIndex = entries.reduce<number>(
		(last, entry, index) => (isUserEntry(entry) ? index : last),
		-1,
	);
	const finalTurn = entries.slice(lastUserIndex + 1);
	const assistantEntries = finalTurn.filter(isAssistantEntry);
	const texts = assistantEntries
		.map(entryText)
		.filter((text): text is string => typeof text === 'string');
	const outcome = idleOutcome(entries);
	return {
		outcome,
		texts,
		model: assistantEntries.reduce<Record<string, unknown>>((acc, entry) => {
			const ids = entryModelIds(entry);
			if (ids.providerID !== undefined && ids.modelID !== undefined) {
				return { providerID: ids.providerID, modelID: ids.modelID };
			}
			return acc;
		}, {}),
		needsErrorLookup:
			outcome === 'failed' || (outcome === undefined && texts.length === 0),
	};
}

function buildTranslatedPromptData(
	classification: ContextClassification,
	recordedError: unknown,
): TranslatedPromptData {
	if (classification.needsErrorLookup || recordedError !== undefined) {
		return {
			info: { error: recordedErrorToInfoError(recordedError) },
			parts: [],
		};
	}
	return {
		info: classification.model,
		parts: classification.texts.map((text) => ({
			type: 'text' as const,
			text,
		})),
	};
}

/** Bounded recheck of the error store for pump lag (deferred-named for the C6 scan). */
async function deferredV2SessionErrorRecheck(realId: string): Promise<unknown> {
	for (let attempt = 0; attempt < ERROR_RECHECK_ATTEMPTS; attempt += 1) {
		if (sessionErrors.has(realId)) return sessionErrors.get(realId);
		if (attempt < ERROR_RECHECK_ATTEMPTS - 1) {
			await new Promise((resolve) =>
				setTimeout(resolve, ERROR_RECHECK_DELAY_MS),
			);
		}
	}
	return undefined;
}

/**
 * Classify + translate a context() entry list, consulting the event-sourced
 * error store ONLY on the paths where a recorded error decides the verdict
 * (successful turns never pay the bounded recheck latency).
 */
async function deferredV2SessionTranslate(
	entries: unknown[],
	sessionId: string,
): Promise<TranslatedPromptData> {
	const classification = classifyContextEntries(entries);
	let recordedError: unknown = sessionErrors.get(sessionId);
	if (classification.needsErrorLookup && recordedError === undefined) {
		recordedError = await deferredV2SessionErrorRecheck(sessionId);
	}
	return buildTranslatedPromptData(classification, recordedError);
}

/** Read the parent session's directory for the placement precheck. */
async function deferredV2SessionGetParentDirectory(
	ctx: V2PluginContext,
	parentID: string,
): Promise<string | undefined> {
	const info = await ctx.session.get({ sessionID: parentID });
	if (!info || typeof info !== 'object') return undefined;
	const location = (info as { location?: { directory?: unknown } }).location;
	return typeof location?.directory === 'string'
		? location.directory
		: undefined;
}

/**
 * Bounded wait: raced against the caller's signal when present (v1 blocking
 * parity — the dispatcher's own timeout owns the bound); a 10-minute cap
 * backstops signal-less callers. Abort/expiry interrupts the v2 session, then
 * rejects with a typed error.
 */
async function deferredV2SessionWait(
	ctx: V2PluginContext,
	realId: string,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (signal?.aborted) {
		await ctx.session.interrupt({ sessionID: realId }).catch(() => undefined);
		throw new Error('v2 session-client: prompt wait aborted');
	}
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const timer =
			signal === undefined
				? setTimeout(() => {
						if (settled) return;
						settled = true;
						ctx.session
							.interrupt({ sessionID: realId })
							.catch(() => undefined)
							.finally(() => {
								reject(
									new Error(
										'v2 session-client: signal-less prompt wait exceeded cap',
									),
								);
							});
					}, SIGNAL_LESS_WAIT_CAP_MS)
				: undefined;
		const onAbort = () => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			ctx.session
				.interrupt({ sessionID: realId })
				.catch(() => undefined)
				.finally(() => {
					reject(new Error('v2 session-client: prompt wait aborted'));
				});
		};
		signal?.addEventListener('abort', onAbort, { once: true });
		Promise.resolve(ctx.session.wait({ sessionID: realId }))
			.then(() => {
				if (settled) return;
				settled = true;
				if (timer !== undefined) clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);
				resolve();
			})
			.catch((error: unknown) => {
				if (settled) return;
				settled = true;
				if (timer !== undefined) clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);
				reject(error instanceof Error ? error : String(error));
			});
	});
}

function makeV2SessionContextHandler(
	realId: string,
	system: string | undefined,
	tools: Readonly<Record<string, false>> | undefined,
): (event: unknown) => Promise<void> {
	return (event: unknown) => {
		const typed = event as V2SessionContextEvent;
		if (!typed || typed.sessionID !== realId) return Promise.resolve();
		if (system !== undefined && Array.isArray(typed.system)) {
			// Fence-aware replacement: provenance-fenced parts (#2526 carriers)
			// survive; everything else yields to the replacement prompt.
			const fenced = typed.system.filter(
				(part) =>
					part &&
					typeof part.text === 'string' &&
					part.text.includes(SYSTEM_DIRECTIVE_FENCE_OPEN),
			);
			typed.system.length = 0;
			typed.system.push(
				...fenced.map((part) => ({ type: 'text' as const, text: part.text })),
				{ type: 'text' as const, text: system },
			);
		}
		if (tools && typed.tools && typeof typed.tools === 'object') {
			let deleted = 0;
			for (const name of Object.keys(tools)) {
				if (Object.hasOwn(typed.tools, name)) {
					delete typed.tools[name as keyof typeof typed.tools];
					deleted += 1;
				}
			}
			if (deleted > 0) {
				log('v2 session-client: denied tools via context hook', {
					count: deleted,
				});
			}
		}
		return Promise.resolve();
	};
}

function promptBodyText(parts: unknown): string {
	if (!Array.isArray(parts)) return '';
	const texts: string[] = [];
	for (const part of parts) {
		if (
			part &&
			typeof part === 'object' &&
			(part as { type?: unknown }).type === 'text' &&
			typeof (part as { text?: unknown }).text === 'string'
		) {
			texts.push((part as { text: string }).text);
		}
	}
	return texts.join('\n');
}

/** The placeholder-path blocking prompt: real create + hook + prompt + wait + context. */
async function deferredV2SessionPromptPlaceholder(
	ctx: V2PluginContext,
	_placeholderId: string,
	stash: PlaceholderRecord,
	body: {
		agent?: unknown;
		model?: { providerID?: unknown; modelID?: unknown };
		system?: unknown;
		tools?: Readonly<Record<string, false>>;
	},
	text: string,
	signal: AbortSignal | undefined,
): Promise<{ data: TranslatedPromptData }> {
	// Mark in-flight SYNCHRONOUSLY (before the first await): the caller's
	// abort/delete teardown can arrive while realId is still unbound, and the
	// pending flags only help when promptStarted is already set.
	stash.promptStarted = true;
	// If the caller's signal is already aborted, do not create anything — the
	// dispatcher's awaitWithAbort would reject this call without cleanup.
	if (signal?.aborted) {
		throw new Error('v2 session-client: prompt wait aborted');
	}
	const agent = typeof body.agent === 'string' ? body.agent : undefined;
	const model =
		body.model &&
		typeof body.model.providerID === 'string' &&
		typeof body.model.modelID === 'string'
			? { id: body.model.modelID, providerID: body.model.providerID }
			: undefined;
	const system = typeof body.system === 'string' ? body.system : undefined;
	// Inline (not a prebuilt object) so the session.create directory-expression
	// guardrail (tests/unit/config/session-create-directory-guardrail.test.ts)
	// can trace `stash.directory` to its origin — the v1 caller's
	// `query.directory`.
	const created = await ctx.session.create({
		...(stash.parentID !== undefined ? { parentID: stash.parentID } : {}),
		...(stash.title !== undefined ? { title: stash.title } : {}),
		...(agent !== undefined ? { agent } : {}),
		...(model !== undefined ? { model } : {}),
		location: { directory: stash.directory },
		permissions: readOnlyToolsToV2Permissions(body.tools),
	});
	const createdRecord = created as {
		id?: unknown;
		location?: { directory?: unknown };
	};
	const realId =
		typeof createdRecord?.id === 'string' ? createdRecord.id : undefined;
	if (realId === undefined) {
		throw new Error('v2 session-client: session create returned no id');
	}
	const echoedDirectory =
		typeof createdRecord.location?.directory === 'string'
			? createdRecord.location.directory
			: undefined;
	if (
		echoedDirectory !== undefined &&
		!sameDirectoryLexical(echoedDirectory, stash.directory)
	) {
		await ctx.session.remove({ sessionID: realId }).catch(() => undefined);
		throw new Error(
			`v2 session-client: created session landed in ${echoedDirectory}, not the requested ${stash.directory} (#3169 Phase 0 C1)`,
		);
	}
	// Epoch-scope: a stale recorded error for a recycled host session id must
	// not poison this dispatch.
	sessionErrors.delete(realId);
	let registration: V2Registration | undefined;
	try {
		if (system !== undefined || body.tools !== undefined) {
			registration = await ctx.session.hook(
				'context',
				makeV2SessionContextHandler(realId, system, body.tools) as never,
			);
		}
		await ctx.session.prompt({ sessionID: realId, text });
		await deferredV2SessionWait(ctx, realId, signal);
		const entries = await ctx.session.context({ sessionID: realId });
		return {
			data: await deferredV2SessionTranslate(
				Array.isArray(entries) ? entries : [],
				realId,
			),
		};
	} finally {
		stash.realId = realId;
		if (registration?.dispose) {
			await registration.dispose().catch(() => undefined);
		}
		// #3169 Phase 2 review round 1 (host-session-leak race): the dispatcher's
		// teardown can arrive while the wait above is still pending (its
		// awaitWithAbort rejects on timeout/abort without awaiting this
		// promise), so abort/delete hit the PLACEHOLDER before realId is bound
		// and no-op. Those calls set the pending flags instead; now that the
		// real id exists, honor them — best-effort, never throwing.
		if (stash.abortPending) {
			await ctx.session.interrupt({ sessionID: realId }).catch(() => undefined);
		}
		if (stash.deletePending) {
			sessionErrors.delete(realId);
			await ctx.session.remove({ sessionID: realId }).catch(() => undefined);
		}
	}
}

/** The real-session direct prompt path (wake prompts; no create, no system hook). */
async function deferredV2SessionPromptReal(
	ctx: V2PluginContext,
	sessionId: string,
	body: { agent?: unknown },
	text: string,
	signal: AbortSignal | undefined,
): Promise<{ data: TranslatedPromptData }> {
	if (typeof body.agent === 'string') {
		const switchAgent = ctx.session.switchAgent;
		if (typeof switchAgent === 'function') {
			await switchAgent({ sessionID: sessionId, agent: body.agent });
		}
	}
	sessionErrors.delete(sessionId);
	await ctx.session.prompt({ sessionID: sessionId, text });
	await deferredV2SessionWait(ctx, sessionId, signal);
	const entries = await ctx.session.context({ sessionID: sessionId });
	return {
		data: await deferredV2SessionTranslate(
			Array.isArray(entries) ? entries : [],
			sessionId,
		),
	};
}

function resolveSessionId(id: string): string | undefined {
	const stash = placeholderSessions.get(id);
	if (stash === undefined) return id;
	return stash.realId;
}

/** Feature-detect the full surface the shim requires (types.ts host-tolerance contract). */
export function createV2SessionClient(
	ctx: V2PluginContext,
): OpencodeClient | undefined {
	const session = ctx?.session;
	if (!session || typeof session !== 'object') return undefined;
	for (const member of [
		'create',
		'get',
		'remove',
		'prompt',
		'wait',
		'context',
		'interrupt',
		'hook',
	] as const) {
		if (typeof session[member] !== 'function') return undefined;
	}
	const client = {
		session: {
			create: (args: {
				body?: { parentID?: string; title?: string };
				query: { directory: string };
				signal?: AbortSignal;
			}): Promise<{ data: { id: string } | null; error?: unknown }> =>
				deferredV2SessionCreate(ctx, args),
			prompt: (args: {
				path: { id: string };
				body: Record<string, unknown>;
				signal?: AbortSignal;
			}): Promise<{ data: TranslatedPromptData | null; error?: unknown }> =>
				deferredV2SessionPrompt(ctx, args),
			abort: (args: { path: { id: string } }): Promise<unknown> => {
				const id = args?.path?.id;
				const resolved = resolveSessionId(id);
				if (resolved !== undefined) {
					return ctx.session
						.interrupt({ sessionID: resolved })
						.catch(() => undefined);
				}
				// Prompt in flight but realId not yet bound: park the intent —
				// the prompt's finally performs the interrupt once the id exists
				// (review round 1 leak race). A never-prompted placeholder has
				// no host session, so it stays a no-op.
				const stash = placeholderSessions.get(id);
				if (stash?.promptStarted) stash.abortPending = true;
				return Promise.resolve(undefined);
			},
			delete: (args: { path: { id: string } }): Promise<unknown> => {
				const id = args?.path?.id;
				// Resolve BEFORE anything else — the dispatcher's teardown arrives
				// with the PLACEHOLDER id, and the placeholder must map to the
				// real host session (#3169 Phase 2 F2). The stash is KEPT (not
				// consumed): the verified-teardown existence check `get` arrives
				// AFTER this delete and must still resolve to the real id, where
				// the host reports the removed session as gone.
				const resolved = resolveSessionId(id);
				if (resolved !== undefined) {
					sessionErrors.delete(resolved);
					return ctx.session
						.remove({ sessionID: resolved })
						.catch(() => undefined);
				}
				// Same leak race as abort: park the delete for the prompt's
				// finally; a never-prompted placeholder deletes nothing.
				const stash = placeholderSessions.get(id);
				if (stash?.promptStarted) stash.deletePending = true;
				return Promise.resolve(undefined);
			},
			get: (args: { path: { id: string } }): Promise<{ data: unknown }> => {
				const resolved = resolveSessionId(args?.path?.id);
				if (resolved === undefined) return Promise.resolve({ data: null });
				return ctx.session
					.get({ sessionID: resolved })
					.then((info) => ({ data: info }));
			},
		},
	};
	return client as unknown as OpencodeClient;
}

/** The shim's create: placement precheck, then placeholder mint (no host call). */
async function deferredV2SessionCreate(
	ctx: V2PluginContext,
	args: {
		body?: { parentID?: string; title?: string };
		query: { directory: string };
		signal?: AbortSignal;
	},
): Promise<{ data: { id: string } | null; error?: unknown }> {
	const directory = args?.query?.directory;
	if (typeof directory !== 'string' || directory.length === 0) {
		return {
			data: null,
			error: {
				message:
					'v2 session-client: create requires query.directory (v1 contract)',
			},
		};
	}
	const parentID = args?.body?.parentID;
	if (parentID !== undefined) {
		const parentDirectory = await deferredV2SessionGetParentDirectory(
			ctx,
			parentID,
		).catch(() => undefined);
		if (parentDirectory === undefined) {
			return {
				data: null,
				error: {
					message:
						'v2 session-client: parent session placement unverifiable (get returned no location.directory — live-verification item on #3169 Phase 2)',
				},
			};
		}
		if (!sameDirectoryLexical(parentDirectory, directory)) {
			return {
				data: null,
				error: {
					message: `v2 session-client: child sessions inherit the parent directory (#3169 Phase 0 C1); requested ${directory} diverges from parent ${parentDirectory} — refusing to create`,
				},
			};
		}
	}
	placeholderCounter += 1;
	const placeholderId = `v2shim-${placeholderCounter}-${Math.random()
		.toString(36)
		.slice(2, 10)}`;
	rememberPlaceholder(placeholderId, {
		...(parentID !== undefined ? { parentID } : {}),
		...(args?.body?.title !== undefined ? { title: args.body.title } : {}),
		directory,
	});
	return { data: { id: placeholderId } };
}

/** The shim's prompt: placeholder path vs real-session direct path. */
async function deferredV2SessionPrompt(
	ctx: V2PluginContext,
	args: {
		path: { id: string };
		body: Record<string, unknown>;
		signal?: AbortSignal;
	},
): Promise<{ data: TranslatedPromptData | null; error?: unknown }> {
	const id = args?.path?.id;
	if (typeof id !== 'string' || id.length === 0) {
		return {
			data: null,
			error: { message: 'v2 session-client: prompt requires path.id' },
		};
	}
	const body = (args?.body ?? {}) as {
		agent?: unknown;
		model?: { providerID?: unknown; modelID?: unknown };
		system?: unknown;
		tools?: Readonly<Record<string, false>>;
		parts?: unknown;
	};
	const text = promptBodyText(body.parts);
	const stash = placeholderSessions.get(id);
	if (stash !== undefined) {
		return deferredV2SessionPromptPlaceholder(
			ctx,
			id,
			stash,
			body,
			text,
			args?.signal,
		);
	}
	return deferredV2SessionPromptReal(ctx, id, body, text, args?.signal);
}
