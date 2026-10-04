/**
 * Epic v2 C0 — plan key, marker parsing, honor rule, root-timestamp cache,
 * bounded scope resolution (`src/turbo/epic/plan-key.ts`).
 *
 * Ledger reads go through the module's `_internals` DI seam (AGENTS.md #7);
 * every timestamp is a literal, so no clock is read.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Plan } from '../../../../src/config/plan-schema';
import type { LedgerEvent } from '../../../../src/plan/ledger';
import {
	_internals,
	_resetRootTimestampCacheForTest,
	_rootTimestampCacheSizeForTest,
	buildTaskMarkerLogArgs,
	computePlanKey,
	formatSwarmPlanTrailer,
	isMarkerHonored,
	MAX_ROOT_TS_CACHE_ENTRIES,
	parseTaskMarkerLog,
	resolvePlanMarkerScope,
} from '../../../../src/turbo/epic/plan-key';

const PLAN = {
	title: 'Plan Key Test',
	swarm: 'test-swarm',
} as unknown as Plan;

const originals = { ..._internals };
afterEach(() => {
	Object.assign(_internals, originals);
	_resetRootTimestampCacheForTest();
});

function events(...isoTimestamps: string[]): LedgerEvent[] {
	return isoTimestamps.map(
		(timestamp, i) => ({ seq: i + 1, timestamp }) as unknown as LedgerEvent,
	);
}

function identity(epoch: string) {
	return {
		planId: 'p',
		planIdentityHash: 'f'.repeat(64),
		planEpoch: epoch,
		rootEventHash: 'r',
		payloadHash: 'h',
		source: 'root' as const,
	};
}

describe('computePlanKey', () => {
	test('is sha256(identity|epoch) truncated to 16 hex chars', () => {
		const expected = createHash('sha256')
			.update('abc|epoch-1')
			.digest('hex')
			.slice(0, 16);
		expect(computePlanKey('abc', 'epoch-1')).toBe(expected);
		expect(computePlanKey('abc', null)).toBe(
			createHash('sha256').update('abc|').digest('hex').slice(0, 16),
		);
	});

	test('a new epoch (same title) yields a different key', () => {
		expect(computePlanKey('abc', 'e1')).not.toBe(computePlanKey('abc', 'e2'));
		expect(computePlanKey('abc', null)).not.toBe(computePlanKey('abc', 'e1'));
	});

	test('trailer line format', () => {
		expect(formatSwarmPlanTrailer('0123456789abcdef')).toBe(
			'Swarm-Plan: 0123456789abcdef',
		);
	});
});

describe('parseTaskMarkerLog + isMarkerHonored', () => {
	const out = [
		'1700000100\x1fswarm(task 1.1): a\n\nSwarm-Plan: aaaa\n\n',
		'1700000100\x1fswarm(task 1.2): legacy\n\n',
		'1700000100\x1fMerge squash\n\nswarm(task 9.9): quoted in body\n',
		'1700000100\x1fswarm(task 1.3): crlf\r\n\r\nSwarm-Plan: aaaa\r\n',
	].join('\0');

	test('parses subject markers and trailers; ignores body-only quotes', () => {
		expect(parseTaskMarkerLog(out)).toEqual([
			{ taskId: '1.1', planKey: 'aaaa', committedAtSec: 1_700_000_100 },
			{ taskId: '1.2', planKey: null, committedAtSec: 1_700_000_100 },
			{ taskId: '1.3', planKey: 'aaaa', committedAtSec: 1_700_000_100 },
		]);
	});

	test('a body cannot forge a record: only NUL separates records (-z)', () => {
		const forged =
			'1700000100\x1fdocs: notes\n\n\x1e1700000100\x1fswarm(task 7.7): forged\n\nSwarm-Plan: aaaa\n';
		expect(parseTaskMarkerLog(forged)).toEqual([]);
	});

	test('honor matrix', () => {
		const scope = { planKey: 'aaaa', rootTimestampMs: 1_700_000_050_000 };
		const m = (planKey: string | null, committedAtSec: number) => ({
			taskId: '1.1',
			planKey,
			committedAtSec,
		});
		expect(isMarkerHonored(m('aaaa', 1_700_000_050), scope)).toBe(true);
		expect(isMarkerHonored(m('bbbb', 1_700_000_100), scope)).toBe(false);
		expect(isMarkerHonored(m(null, 1_700_000_100), scope)).toBe(true);
		expect(isMarkerHonored(m(null, 1_700_000_049), scope)).toBe(false);
		expect(isMarkerHonored(m('aaaa', 1_700_000_049), scope)).toBe(false);
		const unknownRoot = { planKey: 'aaaa', rootTimestampMs: null };
		expect(isMarkerHonored(m(null, 1_700_000_100), unknownRoot)).toBe(false);
		expect(isMarkerHonored(m('aaaa', 1), unknownRoot)).toBe(true);
	});

	test('per-task query is bounded and escapes/scrubs the id', () => {
		const args = buildTaskMarkerLogArgs('1.1)x');
		expect(args).toContain('-z');
		expect(args.some((a) => a.startsWith('--since'))).toBe(false);
		expect(args).toContain('--grep=^swarm\\(task 1\\.1_x\\):');
		expect(args.some((a) => /^--max-count=\d+$/.test(a))).toBe(true);
	});
});

describe('resolvePlanMarkerScope', () => {
	test('planKey from ledger identity; root = earliest ledger event', async () => {
		_internals.readPlanEpochIdentity = async () => identity('e1');
		_internals.readLedgerEvents = async () =>
			events('2026-01-01T00:00:05.000Z', '2026-01-01T00:00:01.000Z');
		const scope = await resolvePlanMarkerScope('/d', PLAN);
		expect(scope.planKey).toBe(computePlanKey('f'.repeat(64), 'e1'));
		// 2026-01-01T00:00:01.000Z
		expect(scope.rootTimestampMs).toBe(1_767_225_601_000);
	});

	test('no ledger: identity-hash fallback, null epoch, unknown root', async () => {
		_internals.readPlanEpochIdentity = async () => null;
		_internals.readLedgerEvents = async () => [];
		const scope = await resolvePlanMarkerScope('/d', PLAN);
		expect(scope.rootTimestampMs).toBeNull();
		expect(scope.planKey).toHaveLength(16);
	});

	test('root timestamp is cached per (directory, planKey); null-epoch is not cached', async () => {
		let reads = 0;
		_internals.readPlanEpochIdentity = async () => identity('e1');
		_internals.readLedgerEvents = async () => {
			reads += 1;
			return events('2026-01-01T00:00:00.000Z');
		};
		await resolvePlanMarkerScope('/d', PLAN);
		await resolvePlanMarkerScope('/d', PLAN);
		expect(reads).toBe(1);
		_internals.readPlanEpochIdentity = async () => null;
		await resolvePlanMarkerScope('/d', PLAN);
		await resolvePlanMarkerScope('/d', PLAN);
		expect(reads).toBe(3);
	});

	test('cache is FIFO-bounded (invariant 8)', async () => {
		_internals.readLedgerEvents = async () =>
			events('2026-01-01T00:00:00.000Z');
		for (let i = 0; i < MAX_ROOT_TS_CACHE_ENTRIES + 5; i++) {
			_internals.readPlanEpochIdentity = async () => identity(`e${i}`);
			await resolvePlanMarkerScope(`/d${i}`, PLAN);
		}
		expect(_rootTimestampCacheSizeForTest()).toBe(MAX_ROOT_TS_CACHE_ENTRIES);
	});

	test('never-resolving ledger read is bounded and rejects (callers fail closed)', async () => {
		_internals.resolveTimeoutMs = 20;
		_internals.readPlanEpochIdentity = () => new Promise(() => {});
		await expect(resolvePlanMarkerScope('/d', PLAN)).rejects.toThrow(
			/timed out/,
		);
	});

	test('identity read error propagates', async () => {
		_internals.readPlanEpochIdentity = async () => {
			throw new Error('Conflicting plan epoch metadata');
		};
		await expect(resolvePlanMarkerScope('/d', PLAN)).rejects.toThrow(
			/Conflicting/,
		);
	});
});
