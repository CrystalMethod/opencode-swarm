/**
 * Issue #2898 retention-trend diagnostics for `verify-retention`:
 * computeRetentionTrend (pure math) and countPendingAddsSince (git-log add
 * counter with an injected runner — no subprocess, no temp dirs).
 */

import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
	computeRetentionTrend,
	countPendingAddsSince,
	RETENTION_TREND_WINDOW_DAYS,
	RETENTION_WARN_DAYS,
} from '../../../scripts/release-notes-fragments.mjs';

describe('computeRetentionTrend', () => {
	test('computes add rate and days-to-limit for a realistic window', () => {
		expect(
			computeRetentionTrend({
				pending: 506,
				limit: 750,
				addedInWindow: 70,
				windowDays: 14,
			}),
		).toEqual({
			windowDays: 14,
			addedInWindow: 70,
			addRatePerDay: 5,
			daysToLimit: 48.8,
		});
	});

	test('rounds the rate to 2 decimals and the projection to 1', () => {
		const trend = computeRetentionTrend({
			pending: 506,
			limit: 750,
			addedInWindow: 71,
			windowDays: 14,
		});
		expect(trend.addRatePerDay).toBe(5.07);
		// (750 - 506) / 5.07 = 48.12... -> 48.1
		expect(trend.daysToLimit).toBe(48.1);
	});

	test('zero adds in the window yield a null projection, not Infinity', () => {
		expect(
			computeRetentionTrend({
				pending: 10,
				limit: 750,
				addedInWindow: 0,
				windowDays: RETENTION_TREND_WINDOW_DAYS,
			}),
		).toEqual({
			windowDays: 14,
			addedInWindow: 0,
			addRatePerDay: 0,
			daysToLimit: null,
		});
	});

	test('pending over the limit clamps headroom to zero days', () => {
		const trend = computeRetentionTrend({
			pending: 800,
			limit: 750,
			addedInWindow: 14,
			windowDays: 14,
		});
		expect(trend.addRatePerDay).toBe(1);
		expect(trend.daysToLimit).toBe(0);
	});

	test('the 30-day warning horizon is reachable with real-shaped numbers', () => {
		// 506 pending, ~10/day -> 244 headroom / 10 = 24.4 days < 30.
		const trend = computeRetentionTrend({
			pending: 506,
			limit: 750,
			addedInWindow: 140,
			windowDays: 14,
		});
		expect(trend.daysToLimit).not.toBe(null);
		expect(trend.daysToLimit as number).toBeLessThan(RETENTION_WARN_DAYS);
	});

	test('rejects malformed inputs fail-closed', () => {
		expect(() =>
			computeRetentionTrend({
				pending: -1,
				limit: 750,
				addedInWindow: 1,
				windowDays: 14,
			}),
		).toThrow(/pending/);
		expect(() =>
			computeRetentionTrend({
				pending: 1,
				limit: 0,
				addedInWindow: 1,
				windowDays: 14,
			}),
		).toThrow(/limit/);
		expect(() =>
			computeRetentionTrend({
				pending: 1,
				limit: 750,
				addedInWindow: -3,
				windowDays: 14,
			}),
		).toThrow(/added/);
		expect(() =>
			computeRetentionTrend({
				pending: 1,
				limit: 750,
				addedInWindow: 1,
				windowDays: 0.5,
			}),
		).toThrow(/window/);
	});
});

describe('countPendingAddsSince', () => {
	test('counts non-empty lines from git log --name-only output', () => {
		let observedArgv: string[] = [];
		let observedCwd = '';
		const added = countPendingAddsSince(
			'E:/repo-root'.replaceAll('/', path.sep),
			'2026-09-08T00:00:00.000Z',
			(argv: string[], cwd: string) => {
				observedArgv = argv;
				observedCwd = cwd;
				return 'docs/releases/pending/a.md\n\ndocs/releases/pending/b.md\ndocs/releases/pending/c.md\n';
			},
		);
		expect(added).toBe(3);
		expect(observedCwd.replaceAll(path.sep, '/')).toBe('E:/repo-root');
		expect(observedArgv).toEqual([
			'log',
			'--diff-filter=A',
			'--name-only',
			'--pretty=format:',
			'--since',
			'2026-09-08T00:00:00.000Z',
			'--',
			'docs/releases/pending',
		]);
	});

	test('empty git output counts as zero adds', () => {
		expect(
			countPendingAddsSince('E:/repo-root', '2026-09-08T00:00:00Z', () => ''),
		).toBe(0);
	});

	test('rejects a non-ISO since timestamp', () => {
		expect(() =>
			countPendingAddsSince('E:/repo-root', 'yesterday', () => ''),
		).toThrow(/ISO-8601/);
	});
});
