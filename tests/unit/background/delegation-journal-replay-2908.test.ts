/**
 * Captured-journal replay test (issue #2908, AC5).
 *
 * Provenance: tests/fixtures/background-delegations-2908.jsonl is a sanitized
 * capture of a REAL review run's delegation ledger (36 swarm-pr-* lanes plus
 * one blocking record; captured 2026-09-09 from a live plugin checkout's
 * .swarm/background-delegations.jsonl). Sanitization replaced every
 * prose-like string (result text/error, receipts, workspace descriptions)
 * with placeholders, recomputed the sanitized text digests/chars, and left
 * ids, statuses, typed terminals (eventIds opaque), timestamps and lanes
 * verbatim — the fold surface is byte-faithful to the live capture.
 *
 * The EXPECTED_TERMINALS table below is derived from the PRE-sanitization
 * raw capture (folded at authoring time), NOT recomputed from the fixture,
 * so a fold defect cannot satisfy this test circularly.
 *
 * Checkpoint coverage: the second test force-compacts a copy through the real
 * compaction (issue #2034) and requires the checkpoint+tail fold to equal the
 * legacy-ledger fold.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	BACKGROUND_DELEGATIONS_CHECKPOINT_FILE,
	BACKGROUND_DELEGATIONS_FILE,
	compactBackgroundDelegations,
	readDelegationsDetailed,
} from '../../../src/background/pending-delegations.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const FIXTURE = path.join(
	import.meta.dir,
	'..',
	'..',
	'fixtures',
	'background-delegations-2908.jsonl',
);

/** [correlationId, folded status] pairs from the pre-sanitization live fold. */
const EXPECTED_TERMINALS: ReadonlyArray<readonly [string, string]> = [
	['generic-session', 'completed'],
	['ses_f780661b8ffeKVytukSMmXiUjK', 'completed'],
	['ses_f78223af1ffezqL2yjztcFR25t', 'error'],
	['ses_f7822a1adffer5PC5gpMMdQs1h', 'error'],
	['ses_f7828c298ffeCZ0HEFvtQbOfyC', 'completed'],
	['ses_f782d77e9ffe0R7RKIplZxYkz6', 'completed'],
	['ses_f78343dfeffeikKu9HThId8FKY', 'error'],
	['ses_f783ab7e7ffegy2Ixw28ubS3Uo', 'error'],
	['ses_f783e0c4affekfenWq0og39s23', 'error'],
	['ses_f7859e908fferd9vSSa4cCRY4x', 'error'],
	['ses_f7859e90affeZowf2esfRouJyd', 'completed'],
	['ses_f7859e90dffefmWre31WpSbKBu', 'completed'],
	['ses_f78731cbbffeuR7HrtmGDf4RWW', 'completed'],
	['ses_f78731cbfffex6S65hq3PdJ3ya', 'completed'],
	['ses_f788217ebffeJUQWUVmw5fP2Tn', 'completed'],
	['ses_f788479edffeFk8UPNQ0ie1tmS', 'error'],
	['ses_f78885dd9ffemRib9saAZ5o4no', 'completed'],
	['ses_f788c4161ffeHSSQPt3nkD773h', 'error'],
	['ses_f789013b0ffev462iSMRfkkuOz', 'completed'],
	['ses_f78929f79ffeR1u8qTedtdGzeD', 'error'],
	['ses_f7896a2a7ffeC5S0t2HhWLMbMI', 'completed'],
	['ses_f7896a2aeffeYV63aYBLgJBfBO', 'completed'],
	['ses_f789ae3abffesAONwyE0C9fyMQ', 'error'],
	['ses_f789ae3aeffeG63zA3btvYUb37', 'error'],
	['ses_f78b34075ffer0O471luHxyvHV', 'completed'],
	['ses_f78b34078ffe4KHAz6XSFyK7M2', 'completed'],
	['ses_f78b93013ffe4wBKGXQhS9sgVh', 'error'],
	['ses_f78be3278ffekF8OT17dazzX71', 'error'],
	['ses_f78c3e8dfffeel3lHxw2vDY23g', 'error'],
	['ses_f78c3e8e3ffe06u0Onlf9Fu0SJ', 'completed'],
	['ses_f78c3e8ebffe1RDqFMumz0WlMO', 'completed'],
	['ses_f78cbaa07ffeCni8764CoN8ixj', 'completed'],
	['ses_f78cbaa0cffeKWwQ9PVGyh81Ta', 'completed'],
	['ses_f791276daffeY2h44zfevcPrXb', 'error'],
	['ses_f791797faffeqcENn64x4yvok8', 'error'],
	['ses_f791b2301ffexhI5LU8EUL33G2', 'error'],
	['ses_f79203fa0ffeiX438JTq3eJgSL', 'error'],
];

describe('captured-journal replay (issue #2908)', () => {
	const dirs: string[] = [];

	const seedStore = (): string => {
		const dir = canonicalMkdtemp('delegation-replay-2908-');
		dirs.push(dir);
		fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.copyFileSync(
			FIXTURE,
			path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_FILE),
		);
		return dir;
	};

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// Windows EBUSY retries are environmental; the prefix makes leaks findable.
			}
		}
	});

	test('legacy-ledger fold equals the recorded live terminal set', () => {
		const dir = seedStore();
		const outcome = readDelegationsDetailed(dir);
		expect(outcome.status).toBe('ok');
		if (outcome.status !== 'ok') return;
		// Record-count guard: the lenient reader must not have skipped any line.
		expect(outcome.records.length).toBe(EXPECTED_TERMINALS.length);
		const folded = new Map(
			outcome.records.map((record) => [record.correlationId, record]),
		);
		expect(folded.size).toBe(EXPECTED_TERMINALS.length);
		const completed = EXPECTED_TERMINALS.filter(
			([, status]) => status === 'completed',
		).length;
		const errors = EXPECTED_TERMINALS.filter(
			([, status]) => status === 'error',
		).length;
		expect(completed).toBe(19);
		expect(errors).toBe(18);
		for (const [correlationId, status] of EXPECTED_TERMINALS) {
			const record = folded.get(correlationId);
			expect(
				record,
				`missing folded record for ${correlationId}`,
			).toBeDefined();
			if (!record) continue;
			expect(record.status, correlationId).toBe(status);
			expect(record.terminalResult?.status, correlationId).toBe(status);
			expect(record.completedAt, correlationId).toBeGreaterThan(0);
		}
	});

	test('checkpoint+tail fold after real compaction equals the legacy fold', async () => {
		const dir = seedStore();
		const legacy = readDelegationsDetailed(dir);
		expect(legacy.status).toBe('ok');
		if (legacy.status !== 'ok') return;
		const compact = await compactBackgroundDelegations(dir, { force: true });
		expect(compact.status).not.toBe('skipped');
		expect(
			fs.existsSync(
				path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_CHECKPOINT_FILE),
			),
			'compaction must publish a checkpoint',
		).toBe(true);
		const refolded = readDelegationsDetailed(dir);
		expect(refolded.status).toBe('ok');
		if (refolded.status !== 'ok') return;
		expect(refolded.records.length).toBe(legacy.records.length);
		const byId = new Map(legacy.records.map((r) => [r.correlationId, r]));
		for (const record of refolded.records) {
			const before = byId.get(record.correlationId);
			expect(before, record.correlationId).toBeDefined();
			if (!before) continue;
			expect(record.status).toBe(before.status);
			expect(record.terminalResult?.status).toBe(before.terminalResult?.status);
			expect(record.terminalResult?.eventId).toBe(
				before.terminalResult?.eventId,
			);
			expect(record.completedAt).toBe(before.completedAt);
		}
	});
});
