/**
 * Unified Injection Budget Service (FR-002).
 *
 * Two responsibilities: (1) the pure, side-effect-free FR-002 allocation
 * function for the combined system-enhancer + knowledge-injector injection
 * ceiling, and (2) the per-session/per-turn producer ledger (#2107 §2) that
 * every model-visible producer claims from or records emissions into.
 *
 * Allocation strategy: proportional share.
 * - When combined demand fits within the budget, each component receives its
 *   full requested amount.
 * - When one component alone exceeds the budget, it receives the entire budget
 *   and the other receives zero (SC-005: single-component overrun is impossible).
 * - When both together exceed the budget but neither alone does, the budget is
 *   split proportionally to each component's demand. The system-enhancer
 *   receives the floor of its proportional share; the knowledge-injector
 *   receives the remainder so the total always equals the ceiling (SC-006).
 *
 * Proportional share is chosen over first-come-first-served because this
 * service is a pure function with no knowledge of hook ordering; it must
 * produce the same allocation regardless of which component calls first.
 * Priority-based allocation would require an arbitrary component ranking
 * not specified by the acceptance criteria.
 *
 * Char-to-token conversion goes through the canonical estimator
 * (`estimateTokensFromCharCount` in src/hooks/utils.ts — issue #1616/#2107).
 */

import { estimateTokensFromCharCount } from '../hooks/utils';

/**
 * Allocation result for a single turn's unified injection budget.
 */
export interface InjectionBudgetAllocation {
	/** Tokens granted to the system-enhancer (input was already in tokens). */
	systemEnhancerTokens: number;
	/** Tokens granted to the knowledge-injector (converted from chars to tokens). */
	knowledgeInjectorTokens: number;
	/** Sum of both allocations; never exceeds the configured budget. */
	totalTokens: number;
}

/**
 * Configuration for the unified injection budget.
 */
export interface InjectionBudgetConfig {
	/** Unified ceiling (tokens) for combined system-enhancer + knowledge-injector injection per turn. */
	totalBudgetTokens: number;
}

/**
 * Convert a character count to tokens via the canonical estimator
 * (`estimateTokensFromCharCount` in src/hooks/utils.ts — issue #1616/#2107).
 */
function charsToTokens(chars: number): number {
	return estimateTokensFromCharCount(chars);
}

/**
 * Allocate the unified injection budget between system-enhancer and
 * knowledge-injector for a single turn.
 *
 * The allocation respects the configured ceiling and guarantees:
 * - totalTokens ≤ config.totalBudgetTokens
 * - If one component alone exceeds the budget, the other receives zero.
 * - If combined demand fits, each receives its full demand.
 * - If combined demand exceeds the budget but neither alone does, the split
 *   is proportional to each component's demand.
 *
 * @param systemEnhancerDemandTokens - Tokens requested by the system-enhancer.
 * @param knowledgeInjectorDemandChars - Characters requested by the knowledge-injector.
 * @param config - Budget configuration containing the total ceiling.
 * @returns Allocation breakdown with per-component token grants.
 */
export function allocateInjectionBudget(
	systemEnhancerDemandTokens: number,
	knowledgeInjectorDemandChars: number,
	config: InjectionBudgetConfig,
): InjectionBudgetAllocation {
	const budget = config.totalBudgetTokens;

	// Clamp negative inputs to zero (defensive; callers should pass non-negative values).
	const seDemand = Math.max(0, systemEnhancerDemandTokens);
	const kiChars = Math.max(0, knowledgeInjectorDemandChars);
	const ceiling = Math.max(0, budget);

	// Convert knowledge-injector demand to tokens for comparison.
	const kiDemand = charsToTokens(kiChars);

	// Fast path: both demands fit within the budget.
	if (seDemand + kiDemand <= ceiling) {
		return {
			systemEnhancerTokens: seDemand,
			knowledgeInjectorTokens: kiDemand,
			totalTokens: seDemand + kiDemand,
		};
	}

	// Single-component overrun: the component that alone exceeds the ceiling
	// receives the entire budget; the other receives zero.
	if (seDemand >= ceiling) {
		return {
			systemEnhancerTokens: ceiling,
			knowledgeInjectorTokens: 0,
			totalTokens: ceiling,
		};
	}

	if (kiDemand >= ceiling) {
		return {
			systemEnhancerTokens: 0,
			knowledgeInjectorTokens: ceiling,
			totalTokens: ceiling,
		};
	}

	// Proportional share: both together exceed the budget, but neither alone does.
	// System-enhancer gets the floor of its proportional share; knowledge-injector
	// receives the remainder so the total equals the ceiling exactly.
	const totalDemand = seDemand + kiDemand;
	const seShare = Math.floor((seDemand / totalDemand) * ceiling);
	const kiShare = ceiling - seShare;

	return {
		systemEnhancerTokens: seShare,
		knowledgeInjectorTokens: kiShare,
		totalTokens: ceiling,
	};
}

// ---------------------------------------------------------------------------
// Per-session, per-turn producer ledger (issue #2107 §2; supersedes the FR-002
// "legacy stateful session-ledger API" that shipped with zero production
// callers). One ledger per session; the system-enhancer begins it exactly once
// per request composition; every producer that contributes to the model-visible
// request either claims from it or records its emission as fixed/base content.
// ---------------------------------------------------------------------------

/**
 * Producers that contribute to the model-visible request surface. The
 * `surface` on each accounting entry records WHERE the producer's bytes live:
 * `'system'` entries are pushed to `output.system` in the system.transform
 * chain (invisible to the messages chain and to final accounting's direct
 * measurement of `output.messages` — they MUST be added to the final total via
 * this ledger); `'messages'` entries are spliced into `output.messages` and are
 * therefore already inside the final measurement (attribution only — adding
 * them again would double-count).
 */
export type InjectionProducer =
	| 'system-enhancer'
	| 'knowledge-injector'
	| 'context-capsule'
	| 'memory-recall'
	| 'advisory-queue'
	| 'swarm-command-banner'
	| 'guidance-carrier-fence'
	| 'linked-cohort-advisory'
	| 'spec-drift-advisory'
	| 'final-accounting-warning';

export type InjectionSurface = 'system' | 'messages';

export interface ProducerAccounting {
	/** Tokens the producer asked the ledger for this turn (claims only). */
	requested: number;
	/** Tokens the ledger granted under the ceiling + local max (claims only). */
	granted: number;
	/** Tokens actually emitted to the model-visible surface. */
	emitted: number;
	/** Tokens the producer wanted but did not reach the model-visible surface, whether pruned locally or rejected during downstream carrier delivery. */
	truncated: number;
	surface: InjectionSurface;
}

declare const injectionBudgetReceiptBrand: unique symbol;

/** Opaque, one-shot handle for a turn-ledger reservation. */
export interface InjectionBudgetReceipt {
	readonly [injectionBudgetReceiptBrand]: true;
}

interface InjectionBudgetReceiptData {
	sessionID: string;
	generation: number;
	producer: InjectionProducer;
	surface: InjectionSurface;
	accounting: ProducerAccounting;
	requestedTokens: number;
	grantedTokens: number;
	chargedTokens: number;
	emittedTokensOnRefund: number;
	/** A producer-grant receipt may also retract its undelivered emission. */
	retractEmissionOnRefund: boolean;
	state: 'pending' | 'committed' | 'refunded' | 'stale';
}

const injectionBudgetReceipts = new WeakMap<
	InjectionBudgetReceipt,
	InjectionBudgetReceiptData
>();

export interface TurnLedgerSummary {
	generation: number;
	totalBudget: number;
	/** Ceiling enforcement is only active when `unified_injection_tokens` is configured. */
	ceilingActive: boolean;
	used: number;
	producers: Array<{ producer: InjectionProducer } & ProducerAccounting>;
}

interface TurnLedger {
	generation: number;
	totalBudget: number;
	ceilingActive: boolean;
	used: number;
	producers: Map<InjectionProducer, ProducerAccounting>;
}

const turnLedgers = new Map<string, TurnLedger>();

// ============================================================================
// Bounded session tracking (AGENTS.md invariant 8)
// ============================================================================

const MAX_TRACKED_SESSIONS = 256;

// Eviction note: Map.set on an existing key preserves the ORIGINAL insertion
// position, so eviction is by FIRST-insert order — a long-lived session that is
// re-begun every turn is never evicted by newer sessions, and the worst
// case for a churned-out session is the documented fail-open (claims fall
// to local maxima). Matches the lastBudgetBySession contract in state.ts.

/** Global monotonic turn generation. Embedded per ledger so any consumer can
 * observe that a new request composition began. */
let turnGenerationCounter = 0;

function evictTurnLedgers(): void {
	while (turnLedgers.size > MAX_TRACKED_SESSIONS) {
		const firstKey = turnLedgers.keys().next().value;
		if (firstKey === undefined) break;
		turnLedgers.delete(firstKey);
	}
}

function getOrCreateAccounting(
	ledger: TurnLedger,
	producer: InjectionProducer,
	surface: InjectionSurface,
): ProducerAccounting {
	let accounting = ledger.producers.get(producer);
	if (!accounting) {
		accounting = {
			requested: 0,
			granted: 0,
			emitted: 0,
			truncated: 0,
			surface,
		};
		ledger.producers.set(producer, accounting);
	}
	accounting.surface = surface;
	return accounting;
}

function makeInjectionBudgetReceipt(
	data: Omit<InjectionBudgetReceiptData, 'state'>,
): InjectionBudgetReceipt {
	const receipt = Object.freeze({}) as InjectionBudgetReceipt;
	injectionBudgetReceipts.set(receipt, { ...data, state: 'pending' });
	return receipt;
}

function settleInjectionBudgetReceipt(
	receipt: InjectionBudgetReceipt,
	action: 'commit' | 'refund',
): boolean {
	const data = injectionBudgetReceipts.get(receipt);
	if (!data || data.state !== 'pending') return false;

	const ledger = turnLedgers.get(data.sessionID);
	if (!ledger || ledger.generation !== data.generation) {
		data.state = 'stale';
		return false;
	}
	const accounting = ledger.producers.get(data.producer);
	if (
		!accounting ||
		accounting !== data.accounting ||
		accounting.surface !== data.surface
	) {
		data.state = 'stale';
		return false;
	}

	if (action === 'commit') {
		data.state = 'committed';
		return true;
	}
	accounting.requested = Math.max(
		0,
		accounting.requested - data.requestedTokens,
	);
	accounting.granted = Math.max(0, accounting.granted - data.grantedTokens);
	if (data.retractEmissionOnRefund) {
		const retracted = Math.min(accounting.emitted, data.emittedTokensOnRefund);
		accounting.emitted -= retracted;
		accounting.truncated += retracted;
	}
	if (
		accounting.requested === 0 &&
		accounting.granted === 0 &&
		accounting.emitted === 0 &&
		accounting.truncated === 0
	) {
		ledger.producers.delete(data.producer);
	}
	ledger.used = Math.max(0, ledger.used - data.chargedTokens);
	data.state = 'refunded';
	return true;
}

/**
 * Begin a new turn ledger for a session: reset exactly once at the start of
 * composing that request (the system-enhancer is the first producer and calls
 * this). Mints a fresh generation, so any stale claim from a prior composition
 * is discarded. `ceilingActive` is only true when
 * `context_budget.unified_injection_tokens` is configured; when false the
 * ledger records accounting but never denies a claim (default configs keep
 * their pre-#2107 behavior).
 */
export function beginTurnLedger(
	sessionID: string,
	totalBudget: number,
	ceilingActive: boolean,
): number {
	const generation = ++turnGenerationCounter;
	turnLedgers.set(sessionID, {
		generation,
		totalBudget: Math.max(0, totalBudget),
		ceilingActive,
		used: 0,
		producers: new Map(),
	});
	evictTurnLedgers();
	return generation;
}

/**
 * Claim tokens from the turn ledger. The grant is bounded by the producer's
 * own local maximum (`localMaxTokens`) and, only when the ceiling is active,
 * by what remains of the unified ceiling. When NO ledger exists for the session
 * (system-enhancer never ran this turn — native agent, first turn, or hook
 * disabled), the claim fails open to the local maximum and is not recorded,
 * preserving #1617's fail-open contract; the caller is expected to report that
 * the hard ceiling was unavailable.
 */
interface TurnBudgetClaimResult {
	granted: number;
	ledgerPresent: boolean;
	ceilingActive: boolean;
}

interface TurnBudgetClaimMutation {
	result: TurnBudgetClaimResult;
	receiptData?: Omit<InjectionBudgetReceiptData, 'state'>;
}

function applyTurnBudgetClaim(
	sessionID: string,
	producer: InjectionProducer,
	requestedTokens: number,
	opts?: { localMaxTokens?: number; surface?: InjectionSurface },
): TurnBudgetClaimMutation {
	const requested = Math.max(0, requestedTokens);
	const localMax =
		opts?.localMaxTokens === undefined
			? requested
			: Math.max(0, opts.localMaxTokens);
	const surface = opts?.surface ?? 'system';

	const ledger = turnLedgers.get(sessionID);
	if (!ledger) {
		return {
			result: {
				granted: Math.min(requested, localMax),
				ledgerPresent: false,
				ceilingActive: false,
			},
		};
	}

	const accounting = getOrCreateAccounting(ledger, producer, surface);
	accounting.requested += requested;

	let granted: number;
	let charged = 0;
	if (!ledger.ceilingActive) {
		granted = Math.min(requested, localMax);
	} else {
		const remaining = Math.max(0, ledger.totalBudget - ledger.used);
		granted = Math.min(requested, localMax, remaining);
		charged = granted;
		ledger.used += charged;
	}
	accounting.granted += granted;
	return {
		result: {
			granted,
			ledgerPresent: true,
			ceilingActive: ledger.ceilingActive,
		},
		receiptData: {
			sessionID,
			generation: ledger.generation,
			producer,
			surface,
			accounting,
			requestedTokens: requested,
			grantedTokens: granted,
			chargedTokens: charged,
			emittedTokensOnRefund: 0,
			retractEmissionOnRefund: false,
		},
	};
}

export function claimTurnBudget(
	sessionID: string,
	producer: InjectionProducer,
	requestedTokens: number,
	opts?: { localMaxTokens?: number; surface?: InjectionSurface },
): TurnBudgetClaimResult {
	return applyTurnBudgetClaim(sessionID, producer, requestedTokens, opts)
		.result;
}

/**
 * Claim from the ledger and return an opaque receipt that can settle exactly
 * this claim. A missing ledger keeps the normal fail-open grant and produces
 * no receipt because there is no reservation to commit or refund.
 */
export function claimTurnBudgetWithReceipt(
	sessionID: string,
	producer: InjectionProducer,
	requestedTokens: number,
	opts?: { localMaxTokens?: number; surface?: InjectionSurface },
): TurnBudgetClaimResult & { receipt?: InjectionBudgetReceipt } {
	const mutation = applyTurnBudgetClaim(
		sessionID,
		producer,
		requestedTokens,
		opts,
	);
	return {
		...mutation.result,
		receipt: mutation.receiptData
			? makeInjectionBudgetReceipt(mutation.receiptData)
			: undefined,
	};
}

/**
 * Record a producer's grant without claiming through `claimTurnBudget`.
 *
 * The system-enhancer and knowledge-injector enforce their split through the
 * pure `allocateInjectionBudget` (FR-002 contract, pinned by tests) rather than
 * sequential claims; this books their allocator-derived grants into the shared
 * ceiling so later claimants (capsule, memory recall) draw from what actually
 * remains. When the ceiling is inactive the grant is recorded but deducts
 * nothing. The deduction is clamped to the remaining budget so `used` can never
 * exceed `totalBudget`.
 */
export function recordProducerGrant(
	sessionID: string,
	producer: InjectionProducer,
	requestedTokens: number,
	grantedTokens: number,
	surface: InjectionSurface,
): void {
	applyProducerGrant(
		sessionID,
		producer,
		requestedTokens,
		grantedTokens,
		surface,
	);
}

interface ProducerGrantMutation {
	data: Omit<InjectionBudgetReceiptData, 'state'>;
}

function applyProducerGrant(
	sessionID: string,
	producer: InjectionProducer,
	requestedTokens: number,
	grantedTokens: number,
	surface: InjectionSurface,
	expectedGeneration?: number,
): ProducerGrantMutation | undefined {
	const ledger = turnLedgers.get(sessionID);
	if (
		!ledger ||
		(expectedGeneration !== undefined &&
			ledger.generation !== expectedGeneration)
	) {
		return undefined;
	}
	const accounting = getOrCreateAccounting(ledger, producer, surface);
	const requested = Math.max(0, requestedTokens);
	accounting.requested += requested;
	const granted = Math.max(0, grantedTokens);
	accounting.granted += granted;
	let charged = 0;
	if (ledger.ceilingActive) {
		charged = Math.min(granted, Math.max(0, ledger.totalBudget - ledger.used));
		ledger.used += charged;
	}
	return {
		data: {
			sessionID,
			generation: ledger.generation,
			producer,
			surface,
			accounting,
			requestedTokens: requested,
			grantedTokens: granted,
			chargedTokens: charged,
			emittedTokensOnRefund: 0,
			retractEmissionOnRefund: false,
		},
	};
}

/**
 * Record an allocator-derived producer grant and return a receipt tied to the
 * exact ledger generation and charged amount. `expectedGeneration` prevents a
 * delayed transform from booking into a newer request's replacement ledger.
 */
export function recordProducerGrantWithReceipt(
	sessionID: string,
	producer: InjectionProducer,
	requestedTokens: number,
	grantedTokens: number,
	surface: InjectionSurface,
	options: {
		expectedGeneration?: number;
		retractEmissionOnRefund?: boolean;
		emittedTokensOnRefund?: number;
	} = {},
): InjectionBudgetReceipt | undefined {
	const mutation = applyProducerGrant(
		sessionID,
		producer,
		requestedTokens,
		grantedTokens,
		surface,
		options.expectedGeneration,
	);
	if (!mutation) return undefined;
	return makeInjectionBudgetReceipt({
		...mutation.data,
		retractEmissionOnRefund: options.retractEmissionOnRefund === true,
		emittedTokensOnRefund: Math.max(0, options.emittedTokensOnRefund ?? 0),
	});
}

/**
 * Record what a producer actually emitted (and pruned itself) this turn.
 * Producers that never claim (fixed/base content: advisory queue, banners,
 * the context-budget warning, the final-accounting warning) still record their
 * emission here so the final accounting can include them.
 */
export function recordProducerEmission(
	sessionID: string,
	producer: InjectionProducer,
	emittedTokens: number,
	truncatedTokens: number,
	surface: InjectionSurface,
	options?: { expectedGeneration?: number },
): void {
	applyProducerEmission(
		sessionID,
		producer,
		emittedTokens,
		truncatedTokens,
		surface,
		options?.expectedGeneration,
	);
}

function applyProducerEmission(
	sessionID: string,
	producer: InjectionProducer,
	emittedTokens: number,
	truncatedTokens: number,
	surface: InjectionSurface,
	expectedGeneration?: number,
): Omit<InjectionBudgetReceiptData, 'state'> | undefined {
	const ledger = turnLedgers.get(sessionID);
	if (
		!ledger ||
		(expectedGeneration !== undefined &&
			ledger.generation !== expectedGeneration)
	) {
		return undefined;
	}
	const accounting = getOrCreateAccounting(ledger, producer, surface);
	const emitted = Math.max(0, emittedTokens);
	accounting.emitted += emitted;
	accounting.truncated += Math.max(0, truncatedTokens);
	return {
		sessionID,
		generation: ledger.generation,
		producer,
		surface,
		accounting,
		requestedTokens: 0,
		grantedTokens: 0,
		chargedTokens: 0,
		emittedTokensOnRefund: emitted,
		retractEmissionOnRefund: true,
	};
}

/**
 * Record a direct producer emission and return a receipt that retracts exactly
 * that emission if its carrier is not delivered. A generation mismatch is a
 * no-op, so an old staged transform cannot write into a replacement ledger.
 */
export function recordProducerEmissionWithReceipt(
	sessionID: string,
	producer: InjectionProducer,
	emittedTokens: number,
	surface: InjectionSurface,
	options?: { expectedGeneration?: number },
): InjectionBudgetReceipt | undefined {
	const receiptData = applyProducerEmission(
		sessionID,
		producer,
		emittedTokens,
		0,
		surface,
		options?.expectedGeneration,
	);
	return receiptData ? makeInjectionBudgetReceipt(receiptData) : undefined;
}

/**
 * Snapshot of the session's current turn ledger (null when absent).
 */
/**
 * Deduct tokens from a producer's recorded emission (#2107 §3): downstream
 * system-chain mutators (the role filter) REMOVE strings after the producer
 * recorded them, and the final accounting must not count bytes the model
 * never sees. Floors at zero; no-op without a ledger or producer entry.
 */
export function deductProducerEmission(
	sessionID: string,
	producer: InjectionProducer,
	removedTokens: number,
	options?: { expectedGeneration?: number },
): void {
	const ledger = turnLedgers.get(sessionID);
	if (
		!ledger ||
		(options?.expectedGeneration !== undefined &&
			ledger.generation !== options.expectedGeneration)
	) {
		return;
	}
	const accounting = ledger.producers.get(producer);
	if (!accounting) return;
	accounting.emitted = Math.max(
		0,
		accounting.emitted - Math.max(0, removedTokens),
	);
}

export function getTurnLedgerSummary(
	sessionID: string,
): TurnLedgerSummary | null {
	const ledger = turnLedgers.get(sessionID);
	if (!ledger) return null;
	return {
		generation: ledger.generation,
		totalBudget: ledger.totalBudget,
		ceilingActive: ledger.ceilingActive,
		used: ledger.used,
		producers: Array.from(ledger.producers.entries()).map(
			([producer, accounting]) => ({
				producer,
				requested: accounting.requested,
				granted: accounting.granted,
				emitted: accounting.emitted,
				truncated: accounting.truncated,
				surface: accounting.surface,
			}),
		),
	};
}

/**
 * Emitted tokens recorded for one producer this turn (0 when no ledger or the
 * producer has not run). Replaces the old `getSystemEnhancerDemand` relay: the
 * knowledge-injector reads the system-enhancer's actual emission from here.
 */
export function getProducerEmission(
	sessionID: string,
	producer: InjectionProducer,
): number {
	return turnLedgers.get(sessionID)?.producers.get(producer)?.emitted ?? 0;
}

/** Commit exactly one live receipt. Repeated or stale commits are no-ops. */
export function commitInjectionBudgetReceipt(
	receipt: InjectionBudgetReceipt,
): boolean {
	return settleInjectionBudgetReceipt(receipt, 'commit');
}

/**
 * Refund exactly one live receipt. Repeated, post-commit, or stale-generation
 * refunds are no-ops. Grant receipts configured for emission retraction also
 * move only their still-emitted amount into that producer's truncation count.
 */
export function refundInjectionBudgetReceipt(
	receipt: InjectionBudgetReceipt,
): boolean {
	return settleInjectionBudgetReceipt(receipt, 'refund');
}

/**
 * Advance the turn generation for a session: the current ledger is discarded so
 * the next request composition starts from a fresh generation. Called when
 * compaction changes the message surface (`experimental.session.compacting`)
 * and at session teardown.
 */
export function advanceTurnGeneration(sessionID: string): void {
	turnLedgers.delete(sessionID);
}

/**
 * Test/maintenance hook: clear one session's ledger.
 */
export function clearTurnLedger(sessionID: string): void {
	turnLedgers.delete(sessionID);
}

/**
 * Clear every session's ledger. Called from `resetSwarmState` so the
 * plugin-wide reset also resets per-turn producer accounting (zaxbysauce
 * review on PR #2415: the reset pattern must cover ALL module-scoped maps).
 */
export function clearAllTurnLedgers(): void {
	turnLedgers.clear();
}
