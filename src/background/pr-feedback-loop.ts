/**
 * Settling loop for autonomous PR babysitting (issue #2502; #1678 capstone).
 *
 * Composes the three existing legs — the pr_monitor event queue, the PR_FEEDBACK
 * workflow gate, and critic_oversight — into an OPT-IN (triple-gated) pipeline:
 *
 *   claim → classify → authorize (foreign/stale/replay/budgets/circuit)
 *         → oversight (fail-closed) → act (claim-first, exactly one wake)
 *         → settle (typed terminal, idempotent, restorable)
 *
 * TRIPLE OPT-IN (never a default flip): the loop runs only when
 * `pr_monitor.enabled` AND `pr_monitor.auto_pr_feedback` AND
 * `pr_feedback_loop.enabled` are all true.
 *
 * NO-PUBLICATION PROFILE: the only supported `publication` mode today is
 * `'none'` — the loop never arms publication and never pushes; the gate's own
 * armed-publication path remains the only route to a push.
 *
 * Terminal semantics: `completed` is DEFINED as "authorized feedback action
 * performed + recorded + the single wake delivered" (the terminal reason
 * string always states that scope); ladder/workflow outcomes remain the PR
 * workflow gate's business. `paused_for_human` covers budget exhaustion,
 * oversight denial, permanent performer failure, and ambiguous events.
 * `degraded` is the open circuit. `cancelled` is the operator stop.
 *
 * Provenance binding: each settled action records a sha256 digest over the
 * NUL-delimited `type\0repo\0pr\0head\0actionClass` (queueCacheKey precedent);
 * a replayed event is refused, and a foreign event (no matching subscription
 * correlation) or a stale head (event head ≠ freshly evaluated head) can never
 * authorize an action. Base-identity binding (baseRefOid) is deferred — the
 * poll snapshot does not capture base today (plan §OUT OF SCOPE).
 */
import { createHash, randomUUID } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { loadPluginConfig } from '../config/loader';
import {
	activatePrWorkflow,
	writePrWorkflowAtomicJson,
} from '../hooks/pr-workflow-gate';
import { validateSwarmPath } from '../hooks/utils';
import { log, warn } from '../utils/logger';
import { withTimeout } from '../utils/timeout';
import {
	claimPrFeedbackMonitorEvents,
	clearPrFeedbackMonitorEvents,
	type PrFeedbackMonitorEvent,
	readPrFeedbackMonitorQueue,
} from './pr-feedback-event-queue';
import { listActive } from './pr-subscriptions';

export const PR_FEEDBACK_LOOP_STATE_REL = path.join(
	'.swarm',
	'pr-feedback-loop-state.json',
);
const PR_FEEDBACK_CLEANUP_DIR = 'pr-feedback-loop-cleanups';
const PR_FEEDBACK_EVIDENCE_DIR = path.join('.swarm', 'pr-feedback-evidence');
const MAX_TRACKED_SESSIONS = 200;
const MAX_PROCESSED_DIGESTS = 64;
const MAX_PERFORM_ATTEMPTS = 3; // 1 initial + 2 bounded retries (transient only)
const TICK_TIMEOUT_MS = 10_000;

/** Supported monitor event types → feedback action classes (#2502 AC1). */
const SUPPORTED_EVENT_ACTION: Record<string, string> = {
	'pr.ci.failed': 'fix_ci',
	'pr.merge.conflict': 'resolve_conflict',
	'pr.new.comment': 'address_comment',
};

const TRANSIENT_MARKERS =
	/HTTP 5\d\d|HTTP 429|ETIMEDOUT|timeout|temporarily unavailable|ECONNRESET|ECONNREFUSED/i;

export interface PrFeedbackLoopClassification {
	type: string;
	actionClass: string;
	supported: boolean;
	ambiguous: boolean;
	reason: string;
}

export interface PrFeedbackLoopAuthorization {
	authorized: boolean;
	reason: string;
	stale: boolean;
	foreign: boolean;
	replay: boolean;
	oversight?: { dispatched: boolean; verdict?: string; decision?: string };
	budget?: {
		sessionActionsUsed: number;
		sessionActionsMax: number;
		prActionsUsed: number;
		prActionsMax: number;
		exhausted: boolean;
	};
}

export interface PrFeedbackLoopAction {
	kind: string;
	performed: boolean;
	recordPath?: string;
}

export interface PrFeedbackLoopTerminal {
	state:
		| 'completed'
		| 'paused_for_human'
		| 'cancelled'
		| 'degraded'
		| 'refused';
	reason: string;
	receiptPath?: string;
}

export interface PrFeedbackLoopResult {
	ran: boolean;
	reason?: string;
	dedupToken: string | null;
	event: {
		type: string;
		repoFullName: string;
		prNumber: number;
		prUrl: string;
	} | null;
	classification: PrFeedbackLoopClassification | null;
	authorization: PrFeedbackLoopAuthorization | null;
	action: PrFeedbackLoopAction | null;
	terminal: PrFeedbackLoopTerminal | null;
}

interface CircuitState {
	failures: number;
	openUntil: number;
	halfOpenProbes: number;
}

interface InFlightClaim {
	dedupToken: string;
	actionClass: string;
	head: string | null;
	performed: boolean;
	attempts: number;
	claimedAt: string;
}

interface CorrelationState {
	sessionID: string;
	repoFullName: string;
	prNumber: number;
	prActionsUsed: number;
	processedDigests: string[];
	circuit: CircuitState;
	inFlight: InFlightClaim | null;
	terminal: PrFeedbackLoopTerminal | null;
}

interface LoopStateV1 {
	schemaVersion: 1;
	updatedAt: string;
	/** Durable sequence for oversight evidence files (no collision across restarts). */
	oversightSeq: number;
	correlations: Record<string, CorrelationState>;
	/** Session-level terminal records (operator cancellation lands here even
	 * when the session has no prior settlement correlation). */
	sessionTerminals: Record<string, PrFeedbackLoopTerminal>;
}

const LoopStateSchema = z.object({
	schemaVersion: z.literal(1),
	updatedAt: z.string().min(1),
	oversightSeq: z.number().int().nonnegative(),
	correlations: z.record(z.string(), z.any()),
	sessionTerminals: z.record(z.string(), z.any()).default({}),
});

// ── DI seam (tests/checks inject; restore in afterEach) ──────────────────

export type EvaluateCurrentHead = (
	repoFullName: string,
	prNumber: number,
) => Promise<string | null>;

export type DispatchOversightInput = {
	directory: string;
	sessionID: string;
	eventType: string;
	actionClass: string;
	repoFullName: string;
	prNumber: number;
	head: string | null;
};

export type DispatchOversightOutcome = {
	dispatched: boolean;
	verdict?: string;
	decision?: string;
};

export type PerformAuthorizedActionInput = {
	directory: string;
	sessionID: string;
	event: PrFeedbackMonitorEvent;
	actionClass: string;
	publication: 'none';
};

export type PerformAuthorizedActionOutcome = {
	performed: boolean;
	recordPath?: string;
	transient?: boolean;
	permanent?: boolean;
	error?: string;
};

export const _internals: {
	evaluateCurrentHead: EvaluateCurrentHead;
	dispatchOversight: (
		input: DispatchOversightInput,
	) => Promise<DispatchOversightOutcome>;
	performAuthorizedAction: (
		input: PerformAuthorizedActionInput,
	) => Promise<PerformAuthorizedActionOutcome>;
	now: () => number;
	readState: (
		directory: string,
	) => Promise<LoopStateV1 | { corrupt: true }>;
	writeState: (directory: string, state: LoopStateV1) => Promise<void>;
} = {
	/** Default: fresh head via the authenticated gh poll snapshot. */
	async evaluateCurrentHead(_repoFullName, _prNumber) {
		// Deliberately unavailable without a host-injected directory: gh polling
		// needs the project directory for .swarm containment (invariant 4), and
		// process.cwd() is a direct-CLI/test fallback only. Fail-closed → the
		// loop classifies the event ambiguous and stays PENDING. Hosts wire this
		// seam at plugin init with the project directory.
		return null;
	},
	/**
	 * Default oversight dispatch (#2502 B2): the loop's OWN critic_oversight
	 * child-session gate — never mutates full-auto state; evidence under
	 * .swarm/pr-feedback-evidence/{seq}.json from the durable counter in the
	 * loop state file. Fail-closed: an infrastructure failure returns
	 * dispatched:false (the loop pauses, never acts).
	 */
	async dispatchOversight(input) {
		// The real child-session dispatch requires the host opencode client,
		// which is not reachable from this background module without a
		// registered delivery. Until the host wires a client hook here, the
		// loop treats oversight dispatch as unavailable → fail-closed pause.
		// (Production hosts and tests inject this seam; see the module tests.)
		void input;
		return { dispatched: false, verdict: 'unavailable', decision: 'pending' };
	},
	/**
	 * Default authorized action (#2502 B1): claim-first is already done by the
	 * pipeline; activate the canonical PR_FEEDBACK gate and deliver EXACTLY ONE
	 * wake directly (not via the registerPrEventDelivery singleton).
	 */
	async performAuthorizedAction(input) {
		try {
			await activatePrWorkflow(
				input.directory,
				input.sessionID,
				'PR_FEEDBACK',
				{
					requireCheckoutPreflight: true,
					prUrl: input.event.prUrl,
				},
			);
			return {
				performed: true,
				recordPath: path.join('.swarm', 'pr-feedback-loop-state.json'),
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				performed: false,
				transient: TRANSIENT_MARKERS.test(message),
				permanent: !TRANSIENT_MARKERS.test(message),
				error: message,
			};
		}
	},
	now: () => Date.now(),
	async readState(directory) {
		return readLoopState(directory);
	},
	async writeState(directory, state) {
		await writeLoopState(directory, state);
	},
};

// ── State I/O ────────────────────────────────────────────────────────────

function emptyState(): LoopStateV1 {
	return {
		schemaVersion: 1,
		updatedAt: new Date(0).toISOString(),
		oversightSeq: 0,
		correlations: {},
		sessionTerminals: {},
	};
}

function isCorruptState(
	value: LoopStateV1 | { corrupt: true },
): value is { corrupt: true } {
	return (value as { corrupt?: boolean }).corrupt === true;
}

async function readLoopState(directory: string): Promise<
	LoopStateV1 | { corrupt: true }
> {
	const file = path.join(directory, PR_FEEDBACK_LOOP_STATE_REL);
	try {
		const raw = fsSync.readFileSync(file, 'utf-8');
		const parsed = LoopStateSchema.safeParse(JSON.parse(raw));
		if (!parsed.success) {
			return { corrupt: true };
		}
		const data = parsed.data as LoopStateV1;
		data.sessionTerminals ??= {};
		return data;
	} catch (err) {
		// ENOENT = no loop has ever run here → legitimately empty. Any other read
		// error or unparseable content is CORRUPTION of the idempotency basis:
		// proceeding stateless would silently discard processed digests and let a
		// replayed event re-perform. Fail closed (corrupt flag) instead.
		const code = (err as NodeJS.ErrnoException | null)?.code;
		if (code === 'ENOENT') return emptyState();
		return { corrupt: true };
	}
}

async function writeLoopState(
	directory: string,
	state: LoopStateV1,
): Promise<void> {
	// Bounded sessions: FIFO eviction past MAX_TRACKED_SESSIONS (invariant 8).
	const keys = Object.keys(state.correlations);
	if (keys.length > MAX_TRACKED_SESSIONS) {
		for (const key of keys.slice(0, keys.length - MAX_TRACKED_SESSIONS)) {
			delete state.correlations[key];
		}
	}
	// sessionTerminals is bounded the same way: keep the newest
	// MAX_TRACKED_SESSIONS cancel records (one per operator-cancelled session).
	const terminalKeys = Object.keys(state.sessionTerminals);
	if (terminalKeys.length > MAX_TRACKED_SESSIONS) {
		for (const key of terminalKeys.slice(
			0,
			terminalKeys.length - MAX_TRACKED_SESSIONS,
		)) {
			delete state.sessionTerminals[key];
		}
	}
	state.updatedAt = new Date().toISOString();
	// validateSwarmPath treats its filename as relative to <root>/.swarm (it
	// prepends the .swarm segment itself), so pass the name WITHOUT the .swarm
	// prefix — PR_FEEDBACK_LOOP_STATE_REL is the reader-facing public path.
	await writePrWorkflowAtomicJson(
		directory,
		validateSwarmPath(directory, path.basename(PR_FEEDBACK_LOOP_STATE_REL)),
		state,
	);
}

function correlationKey(sessionID: string, repo: string, pr: number): string {
	return `${sessionID}::${repo}::${pr}`;
}

function digestFor(
	type: string,
	repo: string,
	pr: number,
	head: string | null,
	actionClass: string,
): string {
	return createHash('sha256')
		.update(`${type}\0${repo}\0${pr}\0${head ?? ''}\0${actionClass}`, 'utf-8')
		.digest('hex');
}

function isLoopEnabled(config: {
	pr_monitor?: { enabled?: boolean; auto_pr_feedback?: boolean };
	pr_feedback_loop?: { enabled?: boolean };
}): boolean {
	return (
		config.pr_monitor?.enabled === true &&
		config.pr_monitor?.auto_pr_feedback === true &&
		config.pr_feedback_loop?.enabled === true
	);
}

function classifyEvent(event: { type: string }): PrFeedbackLoopClassification {
	const actionClass = SUPPORTED_EVENT_ACTION[event.type];
	if (actionClass) {
		return {
			type: event.type,
			actionClass,
			supported: true,
			ambiguous: false,
			reason: `supported monitor event -> ${actionClass}`,
		};
	}
	return {
		type: event.type,
		actionClass: 'unsupported',
		supported: false,
		ambiguous: false,
		reason: `unsupported monitor event type: ${event.type}`,
	};
}

function emptyResult(reason?: string): PrFeedbackLoopResult {
	return {
		ran: false,
		reason,
		dedupToken: null,
		event: null,
		classification: null,
		authorization: null,
		action: null,
		terminal: null,
	};
}

/**
 * Per-session settlement serialization: the notify hook and explicit callers
 * can race (both read the queue before either claim lands). Concurrent runs
 * would double-perform the authorized action — the second caller instead waits
 * for the first, then observes the queue empty. Bounded (invariant 8).
 */
const settlementsInProgress = new Map<string, Promise<unknown>>();
const settledPromises = new WeakSet<Promise<unknown>>();
const MAX_IN_FLIGHT_SESSIONS = 64;

async function withSettlementLock<T>(
	directory: string,
	sessionID: string,
	fn: () => Promise<T>,
): Promise<T> {
	const key = `${path.resolve(directory)}::${sessionID}`;
	const prior = settlementsInProgress.get(key) ?? Promise.resolve();
	const run = prior.catch(() => {}).then(fn);
	settlementsInProgress.set(key, run);
	if (settlementsInProgress.size > MAX_IN_FLIGHT_SESSIONS) {
		// Evict only SETTLED entries: removing an in-flight promise would orphan
		// its lock and let a follow-up event settle concurrently for that
		// session. Map iteration is insertion-ordered, so this scans oldest
		// first and stops at the first still-running settle.
		for (const [key, promise] of settlementsInProgress) {
			if (settlementsInProgress.size <= MAX_IN_FLIGHT_SESSIONS) break;
			if (settledPromises.has(promise)) settlementsInProgress.delete(key);
		}
	}
	try {
		return await run;
	} finally {
		settledPromises.add(run);
		if (settlementsInProgress.get(key) === run) {
			settlementsInProgress.delete(key);
		}
	}
}

/**
 * Process ONE queued monitor event end-to-end for the session (the #2502
 * completion-fixture unit): claim → classify → authorize → oversight → act →
 * settle. Never throws for expected refusal paths. Serialized per session — a
 * concurrent invocation (notify hook racing an explicit call) waits, then sees
 * the queue empty rather than double-performing.
 */
export async function claimAndProcessPrFeedbackEvent(
	directory: string,
	sessionID: string,
): Promise<PrFeedbackLoopResult> {
	return withSettlementLock(directory, sessionID, () =>
		claimAndProcessPrFeedbackEventUnlocked(directory, sessionID),
	);
}

async function claimAndProcessPrFeedbackEventUnlocked(
	directory: string,
	sessionID: string,
): Promise<PrFeedbackLoopResult> {
	let config: ReturnType<typeof loadPluginConfig>;
	try {
		config = loadPluginConfig(directory);
	} catch {
		return emptyResult('disabled');
	}
	if (!isLoopEnabled(config)) {
		// The disabled no-op still reports the classification/authorization
		// shape (authorized:false, reason naming the disabled gate) so callers
		// and checks can distinguish it from a queue miss.
		const queuePeek = await readPrFeedbackMonitorQueue(
			directory,
			sessionID,
		).catch(() => null);
		const peek = (queuePeek?.events ?? []).find(
			(e) => !e.claimedWorkflowInstanceId,
		);
		return {
			ran: false,
			reason: 'disabled',
			dedupToken: peek?.dedupToken ?? null,
			event: peek
				? {
						type: peek.type,
						repoFullName: peek.repoFullName,
						prNumber: peek.prNumber,
						prUrl: peek.prUrl,
					}
				: null,
			classification: peek ? classifyEvent(peek) : null,
			authorization: {
				authorized: false,
				reason:
					'disabled: pr_feedback_loop requires pr_monitor.enabled + pr_monitor.auto_pr_feedback + pr_feedback_loop.enabled (triple opt-in)',
				stale: false,
				foreign: false,
				replay: false,
			},
			action: { kind: 'none', performed: false },
			terminal: null,
		};
	}

	const queue = await readPrFeedbackMonitorQueue(directory, sessionID).catch(
		() => null,
	);
	const pending = (queue?.events ?? []).find(
		(e) => !e.claimedWorkflowInstanceId,
	);
	if (!pending) return emptyResult('queue-empty');
	const classification = classifyEvent(pending);

	if (!isLoopEnabled(config)) {
		// Defensive re-check after the await (config could not change, but the
		// shape stays uniform for tests).
		return emptyResult('disabled');
	}

	// Claim FIRST (#2502 B1): the idle hook's later queue read finds this event
	// gone — the structural no-double-wake guarantee, independent of
	// event_delivery mode.
	const workflowInstanceId = randomUUID();
	let claimed: PrFeedbackMonitorEvent[] = [];
	try {
		claimed = await claimPrFeedbackMonitorEvents(
			directory,
			sessionID,
			workflowInstanceId,
			pending.prUrl,
			[pending.dedupToken],
		);
	} catch {
		claimed = [];
	}
	const event = claimed[0] ?? pending;
	const dedupToken = event.dedupToken;

	const readResult = await _internals.readState(directory);
	if ('corrupt' in readResult && readResult.corrupt) {
		// Fail closed: the state file holds the idempotency digests and budgets.
		// Settle as paused_for_human WITHOUT writing (a stateless write would
		// wipe the digest ledger on the next successful read) and surface the
		// operator-visible reason.
		return {
			ran: true,
			dedupToken: event.dedupToken,
			event: {
				type: event.type,
				repoFullName: event.repoFullName,
				prNumber: event.prNumber,
				prUrl: event.prUrl,
			},
			classification,
			authorization: {
				authorized: false,
				reason:
					'corrupt loop state: .swarm/pr-feedback-loop-state.json is unreadable or fails schema validation — settle paused so the idempotency ledger is not silently wiped; repair or delete the file to resume',
				stale: false,
				foreign: false,
				replay: false,
			},
			action: { kind: classification.actionClass, performed: false },
			terminal: {
				state: 'paused_for_human',
				reason:
					'corrupt loop state — paused for a human; idempotency ledger preserved on disk',
			},
		};
	}
	const state = readResult as LoopStateV1;
	const key = correlationKey(sessionID, event.repoFullName, event.prNumber);
	const correlation: CorrelationState = state.correlations[key] ?? {
		sessionID,
		repoFullName: event.repoFullName,
		prNumber: event.prNumber,
		prActionsUsed: 0,
		processedDigests: [],
		circuit: { failures: 0, openUntil: 0, halfOpenProbes: 0 },
		inFlight: null,
		terminal: null,
	};
	state.correlations[key] = correlation;

	const head = await _internals
		.evaluateCurrentHead(event.repoFullName, event.prNumber)
		.catch(() => null);

	const base: PrFeedbackLoopResult = {
		ran: true,
		dedupToken,
		event: {
			type: event.type,
			repoFullName: event.repoFullName,
			prNumber: event.prNumber,
			prUrl: event.prUrl,
		},
		classification,
		authorization: null,
		action: null,
		terminal: null,
	};

	// ── Unsupported type: refused, recorded, no action (AC1). ──
	if (!classification.supported) {
		correlation.terminal = {
			state: 'refused',
			reason: classification.reason,
		};
		await _internals.writeState(directory, state);
		return {
			...base,
			authorization: {
				authorized: false,
				reason: classification.reason,
				stale: false,
				foreign: false,
				replay: false,
			},
			action: { kind: 'none', performed: false },
			terminal: correlation.terminal,
		};
	}

	// ── Foreign correlation: no matching active subscription → refuse (AC7). ──
	let foreign = false;
	try {
		const subs = await listActive(directory);
		foreign = !subs.some(
			(sub) =>
				sub.sessionID === sessionID &&
				sub.repoFullName === event.repoFullName &&
				sub.prNumber === event.prNumber,
		);
	} catch {
		foreign = true;
	}

	const digest = digestFor(
		event.type,
		event.repoFullName,
		event.prNumber,
		head,
		classification.actionClass,
	);
	const replay = correlation.processedDigests.includes(digest);

	// ── Ambiguity: head evaluation failed → pending, no write-class action (AC2). ──
	if (head === null) {
		classification.ambiguous = true;
		classification.reason =
			'ambiguous: current head evaluation unavailable — remaining pending for a human';
		if (replay && correlation.terminal) {
			await _internals.writeState(directory, state);
			return {
				...base,
				authorization: {
					authorized: false,
					reason: 'replay: action digest already settled',
					stale: false,
					foreign,
					replay: true,
				},
				terminal: correlation.terminal,
			};
		}
		// PENDING, not a terminal: an ambiguous event must remain unsettled
		// (recorded in state with no terminal) rather than choose a write or
		// claim a human pause — the next non-ambiguous event settles normally.
		correlation.terminal = null;
		await _internals.writeState(directory, state);
		return {
			...base,
			authorization: {
				authorized: false,
				reason:
					'ambiguous: head evaluation returned null — event remains pending',
				stale: false,
				foreign,
				replay,
			},
			action: { kind: classification.actionClass, performed: false },
			terminal: null,
		};
	}

	// ── Authorization: foreign / stale / replay / budgets / circuit. ──
	const now = _internals.now();
	const sessionActionsMax = config.pr_feedback_loop?.max_session_actions ?? 10;
	const prActionsMax = config.pr_feedback_loop?.max_actions_per_pr ?? 3;
	// The SESSION budget spans every PR correlation of this session (the
	// per-PR budget stays per-correlation) — the caps are independent.
	const sessionActionsUsed = Object.values(state.correlations)
		.filter((c) => c.sessionID === sessionID)
		.reduce((sum, c) => sum + c.prActionsUsed, 0);
	const budget = {
		sessionActionsUsed,
		sessionActionsMax,
		prActionsUsed: correlation.prActionsUsed,
		prActionsMax,
		exhausted:
			sessionActionsUsed >= sessionActionsMax ||
			correlation.prActionsUsed >= prActionsMax,
	};
	const circuitOpen = correlation.circuit.openUntil > now;

	const refuseAuthorization = async (
		reason: string,
		extra: { stale?: boolean; replay?: boolean } = {},
		terminal?: PrFeedbackLoopTerminal,
	): Promise<PrFeedbackLoopResult> => {
		if (terminal) correlation.terminal = terminal;
		// Await so the terminal is durable before returning: a fire-and-forget
		// write here races the settlement lock release and a rapid follow-up
		// claimAndProcess could read stale state (or lose the terminal).
		try {
			await _internals.writeState(directory, state);
		} catch (err) {
			warn(
				`[pr-feedback-loop] refusal terminal write failed (state kept in memory): ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
		return {
			...base,
			authorization: {
				authorized: false,
				reason,
				stale: extra.stale ?? false,
				foreign,
				replay: extra.replay ?? replay,
				budget,
			},
			action: { kind: classification.actionClass, performed: false },
			terminal: terminal ?? correlation.terminal,
		};
	};

	if (foreign) {
		return await refuseAuthorization(
			'foreign: event does not match an active subscription correlation for this session',
		);
	}

	// Stale head: the subscription's persisted head must equal the freshly
	// evaluated head — a stale event can never authorize a new checkout (AC7).
	let subscriptionHead: string | null = null;
	try {
		const subs = await listActive(directory);
		subscriptionHead =
			subs.find(
				(sub) =>
					sub.sessionID === sessionID &&
					sub.repoFullName === event.repoFullName &&
					sub.prNumber === event.prNumber,
			)?.headRefOid ?? null;
	} catch {
		subscriptionHead = null;
	}
	const stale = subscriptionHead !== null && subscriptionHead !== head;
	if (stale) {
		return await refuseAuthorization(
			'stale: event head does not match the freshly evaluated PR head',
			{ stale: true },
		);
	}

	// Restoration (#2502 AC8 / R8): a processed digest with no recorded terminal
	// is an interrupted settlement — the digest is itself proof the action
	// settled, so re-record a truthful terminal WITHOUT re-performing.
	if (replay) {
		if (!correlation.terminal) {
			correlation.terminal = {
				state: 'completed',
				reason:
					'restored after interruption: authorized feedback action was performed and recorded; terminal re-recorded without re-performing',
			};
			correlation.inFlight = null;
			await _internals.writeState(directory, state);
			return {
				...base,
				authorization: {
					authorized: false,
					reason: 'replay: action digest already settled (terminal restored)',
					stale: false,
					foreign,
					replay: true,
					budget,
				},
				action: { kind: classification.actionClass, performed: false },
				terminal: correlation.terminal,
			};
		}
		return {
			...base,
			authorization: {
				authorized: false,
				reason: 'replay: action digest already settled',
				stale: false,
				foreign,
				replay: true,
				budget,
			},
			action: { kind: classification.actionClass, performed: false },
			terminal: correlation.terminal,
		};
	}

	if (budget.exhausted) {
		return await refuseAuthorization(
			'budget exhausted: per-session/per-PR action cap reached — pausing for a human',
			{},
			{
				state: 'paused_for_human',
				reason: `budget exhausted (session ${sessionActionsUsed}/${sessionActionsMax}, pr ${correlation.prActionsUsed}/${prActionsMax})`,
			},
		);
	}

	if (circuitOpen) {
		return await refuseAuthorization(
			'circuit open: repeated failures degraded the loop — probe again after the cooldown',
			{},
			{
				state: 'degraded',
				reason: `circuit open until ${correlation.circuit.openUntil} (failures: ${correlation.circuit.failures})`,
			},
		);
	}

	// Half-open probe admission (AC12): once openUntil has passed, exactly one
	// probe event flows through; success closes the circuit, failure re-opens it.
	if (
		correlation.circuit.openUntil > 0 &&
		correlation.circuit.openUntil <= now
	) {
		correlation.circuit.halfOpenProbes += 1;
	}

	// ── Oversight (AC11): fail-closed second-model gate. ──
	state.oversightSeq += 1;
	const oversight = await Promise.resolve(
		_internals.dispatchOversight({
			directory,
			sessionID,
			eventType: event.type,
			actionClass: classification.actionClass,
			repoFullName: event.repoFullName,
			prNumber: event.prNumber,
			head,
		}),
	).catch(
		() =>
			({
				dispatched: false,
				verdict: 'error',
				decision: 'pending',
			}) as DispatchOversightOutcome,
	);

	// Durable evidence record for the dispatch (no full-auto state touched).
	try {
		fsSync.mkdirSync(path.join(directory, PR_FEEDBACK_EVIDENCE_DIR), {
			recursive: true,
		});
		fsSync.writeFileSync(
			path.join(
				directory,
				PR_FEEDBACK_EVIDENCE_DIR,
				`${state.oversightSeq}.json`,
			),
			JSON.stringify(
				{
					schemaVersion: 1,
					at: new Date().toISOString(),
					sessionID,
					eventType: event.type,
					actionClass: classification.actionClass,
					repoFullName: event.repoFullName,
					prNumber: event.prNumber,
					head,
					dedupToken,
					outcome: oversight,
				},
				null,
				2,
			),
			'utf-8',
		);
	} catch (err) {
		warn(
			`[pr-feedback-loop] oversight evidence write failed (non-fatal): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}

	// Approval vocabulary mirrors full-auto's decisionFromVerdict: an explicit
	// 'allow'/'approve' decision or an APPROVE-family verdict (with dispatch)
	// authorizes; deny/pending/blocked and infra failures do not.
	const oversightApproved =
		oversight.dispatched &&
		(oversight.decision === 'allow' ||
			oversight.decision === 'approve' ||
			(/approv/i.test(oversight.verdict ?? '') &&
				oversight.decision !== 'deny' &&
				oversight.decision !== 'pending'));
	const authorization: PrFeedbackLoopAuthorization = {
		authorized: oversightApproved,
		reason: oversightApproved
			? 'oversight approved the authorized feedback action'
			: `oversight did not approve (dispatched=${oversight.dispatched}, decision=${oversight.decision ?? 'none'}, verdict=${oversight.verdict ?? 'none'})`,
		stale: false,
		foreign,
		replay,
		oversight: {
			dispatched: oversight.dispatched,
			verdict: oversight.verdict,
			decision: oversight.decision,
		},
		budget,
	};

	if (!authorization.authorized) {
		correlation.terminal = {
			state: 'paused_for_human',
			reason: `oversight denial/pending: ${authorization.reason} — no action performed, paused for a human`,
		};
		await _internals.writeState(directory, state);
		return {
			...base,
			authorization,
			action: { kind: classification.actionClass, performed: false },
			terminal: correlation.terminal,
		};
	}

	// ── Act: in-flight record BEFORE perform (restoration basis). ──
	correlation.inFlight = {
		dedupToken,
		actionClass: classification.actionClass,
		head,
		performed: false,
		attempts: 0,
		claimedAt: new Date().toISOString(),
	};

	let outcome: PerformAuthorizedActionOutcome = { performed: false };
	for (let attempt = 0; attempt < MAX_PERFORM_ATTEMPTS; attempt++) {
		correlation.inFlight.attempts += 1;
		try {
			outcome = await _internals.performAuthorizedAction({
				directory,
				sessionID,
				event,
				actionClass: classification.actionClass,
				publication: 'none',
			});
		} catch (err) {
			// Performer throws carry the failure classification: transient markers
			// (HTTP 5xx/429/timeout/…) bound the retries; anything else is permanent.
			const message = err instanceof Error ? err.message : String(err);
			outcome = {
				performed: false,
				transient: TRANSIENT_MARKERS.test(message),
				permanent: !TRANSIENT_MARKERS.test(message),
				error: message,
			};
		}
		if (outcome.performed || outcome.permanent || !outcome.transient) break;
		// Bounded transient retry (max 2 retries) — no unbounded loops.
	}
	const action: PrFeedbackLoopAction = {
		kind: classification.actionClass,
		performed: outcome.performed,
		recordPath: outcome.recordPath,
	};

	if (!outcome.performed) {
		correlation.circuit.failures += 1;
		if (outcome.permanent) {
			// Permanent failure: no retries burned beyond the first attempt;
			// pause for a human rather than degrading.
			correlation.terminal = {
				state: 'paused_for_human',
				reason: `permanent action failure: ${outcome.error ?? 'unknown'} — no retry, paused for a human`,
			};
		} else {
			correlation.circuit.openUntil = now + 60_000;
			correlation.terminal = {
				state: 'degraded',
				reason: `transient action failures exhausted the retry budget: ${outcome.error ?? 'unknown'} — circuit open, probe again after cooldown`,
			};
		}
		correlation.inFlight = null;
		await _internals.writeState(directory, state);
		return { ...base, authorization, action, terminal: correlation.terminal };
	}

	correlation.inFlight.performed = true;
	// Session budget is derived (sum of per-PR counters) — only the per-PR
	// counter increments here.
	correlation.prActionsUsed += 1;
	correlation.circuit = { failures: 0, openUntil: 0, halfOpenProbes: 0 };
	correlation.processedDigests.push(digest);
	if (correlation.processedDigests.length > MAX_PROCESSED_DIGESTS) {
		correlation.processedDigests.splice(
			0,
			correlation.processedDigests.length - MAX_PROCESSED_DIGESTS,
		);
	}
	// The terminal reason ALWAYS states the completion scope (#2502 M4/R4):
	// action performed + recorded + the single wake delivered.
	correlation.terminal = {
		state: 'completed',
		reason:
			'authorized feedback action performed, recorded, and the single wake delivered (publication: none; ladder outcomes remain the PR workflow gate business)',
	};
	correlation.inFlight = null;
	await _internals.writeState(directory, state);
	log(
		`[pr-feedback-loop] settled ${event.type} for ${event.repoFullName}#${event.prNumber} (${classification.actionClass})`,
	);
	return {
		...base,
		authorization: {
			...authorization,
			// Post-settle view: the budget the NEXT event will be checked against.
			budget: {
				...budget,
				sessionActionsUsed: sessionActionsUsed + 1,
				prActionsUsed: correlation.prActionsUsed,
			},
		},
		action,
		terminal: correlation.terminal,
	};
}

/**
 * Operator stop (#2502 AC10): terminal `cancelled` with the operator-visible
 * reason, #2584 publication cancellation first (no-op when unarmed,
 * fail-open), claimed-but-unsettled queue events cleared with an atomic
 * cleanup receipt. Idempotent: re-cancel returns the existing terminal.
 * Never issues NEW wakes (an in-flight wake may still surface in the session;
 * the gate's push admission refuses pushes against a cancelled generation).
 */
export async function cancelPrFeedbackLoop(
	directory: string,
	sessionID: string,
	reason: string,
): Promise<{
	terminalState: string;
	reason: string;
	cleanupReceipt: { path: string; clearedEvents: string[] };
}> {
	const readResult = await _internals.readState(directory);
	const state: LoopStateV1 = isCorruptState(readResult)
		? emptyState()
		: readResult;
	const receipt = {
		path: '',
		clearedEvents: [] as string[],
	};

	try {
		// Lazy import keeps this background module off the gate's static graph;
		// the #2584 route is now a typed public export on the gate.
		const { cancelPrFeedbackPublication } = await import(
			'../hooks/pr-workflow-gate.js'
		);
		await cancelPrFeedbackPublication(directory, sessionID, reason);
	} catch (err) {
		warn(
			`[pr-feedback-loop] cancelPrFeedbackPublication failed (fail-open): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}

	const queue = await readPrFeedbackMonitorQueue(directory, sessionID).catch(
		() => null,
	);
	// Everything still in the queue is unsettled — claimed-but-unsettled
	// included (a claim alone never settles). The sanctioned queue-clear
	// primitive removes them so a cancelled loop leaves nothing claimable.
	const unsettled = queue?.events ?? [];
	if (unsettled.length > 0) {
		try {
			receipt.clearedEvents = await clearPrFeedbackMonitorEvents(
				directory,
				sessionID,
				unsettled.map((e) => e.dedupToken),
			);
		} catch {
			// Clearing is best-effort; the receipt still lists the tokens.
			receipt.clearedEvents = unsettled.map((e) => e.dedupToken);
		}
	}

	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	receipt.path = path.join(
		'.swarm',
		PR_FEEDBACK_CLEANUP_DIR,
		`cancel-${stamp}.json`,
	);
	try {
		fsSync.mkdirSync(path.join(directory, '.swarm', PR_FEEDBACK_CLEANUP_DIR), {
			recursive: true,
		});
		fsSync.writeFileSync(
			path.join(directory, receipt.path),
			JSON.stringify(
				{
					schemaVersion: 1,
					at: new Date().toISOString(),
					sessionID,
					reason,
					clearedEvents: receipt.clearedEvents,
				},
				null,
				2,
			),
			'utf-8',
		);
	} catch (err) {
		warn(
			`[pr-feedback-loop] cleanup receipt write failed (non-fatal): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}

	for (const correlation of Object.values(state.correlations)) {
		if (correlation.sessionID !== sessionID) continue;
		if (correlation.terminal?.state === 'cancelled') continue; // idempotent
		correlation.terminal = { state: 'cancelled', reason };
		correlation.inFlight = null;
	}
	state.sessionTerminals[sessionID] = { state: 'cancelled', reason };
	await _internals.writeState(directory, state);
	return { terminalState: 'cancelled', reason, cleanupReceipt: receipt };
}

/**
 * Bounded post-cycle tick (#2502 M7). Settlement today is driven entirely by
 * the per-session notify hook (handlePrEvent → notifyPrFeedbackLoop, which is
 * itself withTimeout-bounded per settlement); the queue store exposes no
 * session enumeration yet, so a cross-session sweep has nothing to iterate.
 * When enumeration lands, this becomes the bounded sweep (at most
 * TICK_SETTLEMENT_CAP settlements per poll cycle IN TOTAL); until then it is
 * an honest no-op that reports zero settlements.
 */
export async function tickPrFeedbackLoop(_directory: string): Promise<number> {
	return 0;
}

/** Notify hook for pr-event-subscribers: fire-and-forget, fail-open. */
export function notifyPrFeedbackLoop(
	directory: string,
	sessionID: string,
): void {
	// withTimeout is Promise.race: the timeout rejection is consumed by the
	// .catch below, but the SETTLE promise itself can still reject later (e.g.
	// a writeState I/O failure) and its rejection needs its own handler or it
	// becomes an unhandled rejection after the race already settled.
	const settle = claimAndProcessPrFeedbackEvent(directory, sessionID);
	settle.catch((err) => {
		warn(
			`[pr-feedback-loop] settle rejected (notify path, non-fatal): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	});
	void withTimeout(
		settle,
		TICK_TIMEOUT_MS,
		new Error('pr-feedback-loop tick timeout'),
	).catch(() => {});
}
