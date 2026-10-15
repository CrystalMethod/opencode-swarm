/**
 * Settle/admit census ratchet (issue #2908, AC2).
 *
 * Re-runs the census recorded in docs/pr-review-transition-authority.md
 * ("Settle/admit call-site census") against a fresh scan of src/ via
 * tests/helpers/terminal-writer-scanner.ts. The coupling is enforced in three
 * directions:
 *
 *  1. every scanner identity owns exactly one census row of the right class;
 *  2. every scan/inventory row's cited hit lines EQUAL the scanner's actual hit
 *     lines for that identity — so a NEW call site inside an already
 *     inventoried function fails as an un-cited hit, and a stale citation
 *     fails as a phantom (PR #3284 review findings PRR-002, PRR-026);
 *  3. every disposition is a census token and no row is a `straggler`.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	SCANNER_PATTERN_COUNT,
	type ScanResult,
	scanSource,
	scanSrc,
} from '../../helpers/terminal-writer-scanner.js';

const REPO_ROOT = path.join(import.meta.dir, '..', '..', '..');
const DOC = path.join(REPO_ROOT, 'docs', 'pr-review-transition-authority.md');
const DISPOSITIONS = new Set(['routed', 'deliberate-second-authority']);
const DIRECT_PATTERNS = new Set([1, 2, 3, 4, 5, 7, 8, 9, 10]);

interface CensusRow {
	site: string;
	authority: string;
	rowClass: string;
	disposition: string;
	hitLines: number[];
}

function parseCensusRows(): CensusRow[] {
	const text = fs.readFileSync(DOC, 'utf-8').replace(/\r/g, '');
	const lines = text.split('\n');
	const headerIndex = lines.indexOf(
		'| Site | Writes or admits | Authority | Row class | Disposition | Reason |',
	);
	expect(headerIndex, 'census table header must exist').toBeGreaterThanOrEqual(
		0,
	);
	const rows: CensusRow[] = [];
	for (const line of lines.slice(headerIndex + 1)) {
		if (!line.startsWith('|')) break;
		const cells = line.split('|').map((cell) => cell.trim());
		if (cells.length < 8 || cells[1] === 'Site' || cells[1].startsWith('---')) {
			continue;
		}
		rows.push({
			site: cells[1],
			authority: cells[3],
			rowClass: cells[4],
			disposition: cells[5],
			hitLines: [...cells[2].matchAll(/:(\d+)/g)]
				.map((match) => Number(match[1]))
				.sort((a, b) => a - b),
		});
	}
	expect(
		rows.length,
		'census must list at least 40 rows',
	).toBeGreaterThanOrEqual(40);
	return rows;
}

function classify(hits: ScanResult, identity: string): 'scan' | 'inventory' {
	return hits.hits.some(
		(hit) => hit.identity === identity && DIRECT_PATTERNS.has(hit.pattern),
	)
		? 'scan'
		: 'inventory';
}

function hitLinesFor(hits: ScanResult, identity: string): number[] {
	return [
		...new Set(
			hits.hits
				.filter((hit) => hit.identity === identity)
				.map((hit) => hit.line),
		),
	].sort((a, b) => a - b);
}

export interface CensusFindings {
	missingScan: string[];
	missingInventory: string[];
	phantom: string[];
	uncited: string[];
	stale: string[];
}

/**
 * The enforcement closure, parameterized so a SYNTHETIC scan can drive it — the
 * demos below run it against a rogue writer, so the join itself is exercised,
 * not just the scanner (PR #3284 review finding PRR-033).
 */
export function censusFindings(
	hits: ScanResult,
	rows: CensusRow[],
): CensusFindings {
	const docScan = rows.filter((r) => r.rowClass === 'scan').map((r) => r.site);
	const docInventory = rows
		.filter((r) => r.rowClass === 'inventory')
		.map((r) => r.site);
	const missingScan: string[] = [];
	const missingInventory: string[] = [];
	for (const identity of hits.identities) {
		const cls = classify(hits, identity);
		if (cls === 'scan' && !docScan.includes(identity))
			missingScan.push(identity);
		if (cls === 'inventory' && !docInventory.includes(identity)) {
			missingInventory.push(identity);
		}
	}
	const all = new Set(hits.identities);
	const phantom = rows
		.filter((r) => r.rowClass === 'scan' || r.rowClass === 'inventory')
		.map((r) => r.site)
		.filter((site) => !all.has(site));
	const uncited: string[] = [];
	const stale: string[] = [];
	for (const row of rows) {
		if (row.rowClass !== 'scan' && row.rowClass !== 'inventory') continue;
		const actual = hitLinesFor(hits, row.site);
		for (const line of actual) {
			if (!row.hitLines.includes(line)) uncited.push(`${row.site}:${line}`);
		}
		for (const line of row.hitLines) {
			if (!actual.includes(line)) stale.push(`${row.site}:${line}`);
		}
	}
	return { missingScan, missingInventory, phantom, uncited, stale };
}

describe('settle/admit census ratchet (issue #2908)', () => {
	const scan = scanSrc(REPO_ROOT);
	const rows = parseCensusRows();
	const findings = censusFindings(scan, rows);

	test('non-vacuity: the scan covers the real src tree with every pattern live', () => {
		expect(scan.fileCount).toBeGreaterThan(1000);
		expect(scan.skippedFiles, 'no source file may be skipped').toEqual([]);
		expect(scan.depthLimited).toBe(false);
		expect(SCANNER_PATTERN_COUNT).toBe(10);
		for (let pattern = 1; pattern <= SCANNER_PATTERN_COUNT; pattern += 1) {
			expect(
				scan.hits.filter((hit) => hit.pattern === pattern).length,
				`pattern ${pattern} finds nothing`,
			).toBeGreaterThan(0);
		}
	});

	test('every scanner identity has a census row of the right class', () => {
		expect(
			findings.missingScan,
			'scan identities absent from the census',
		).toEqual([]);
		expect(
			findings.missingInventory,
			'inventory identities absent from the census',
		).toEqual([]);
	});

	test('every census row matches a scanner identity, with no duplicates', () => {
		expect(findings.phantom, 'census rows with no scanner identity').toEqual(
			[],
		);
		const sites = rows.map((row) => row.site);
		expect(sites.length, 'duplicate census identities').toBe(
			new Set(sites).size,
		);
	});

	test('every cited hit line reconciles with the scan', () => {
		expect(
			findings.uncited,
			'these scan hits are not cited by their census row',
		).toEqual([]);
		expect(
			findings.stale,
			'these cited lines have no scan hit (stale citations)',
		).toEqual([]);
	});

	test('dispositions are census tokens and zero rows are stragglers', () => {
		expect(
			rows
				.filter((row) => !DISPOSITIONS.has(row.disposition))
				.map((row) => `${row.site}: ${row.disposition}`),
		).toEqual([]);
		expect(rows.filter((row) => row.disposition === 'straggler')).toEqual([]);
	});

	test('every scan row names an authority', () => {
		expect(
			rows
				.filter((row) => row.rowClass === 'scan' && row.authority.length < 3)
				.map((row) => row.site),
		).toEqual([]);
	});

	test('cross-reference rows point at real authority surfaces', () => {
		const cross = rows.filter((row) => row.rowClass === 'cross-reference');
		expect(cross.length).toBeGreaterThanOrEqual(3);
		for (const row of cross) {
			const target = row.site.split(' ')[0];
			expect(
				fs.existsSync(path.join(REPO_ROOT, target)),
				`cross-reference target missing: ${target}`,
			).toBe(true);
		}
	});

	test('demo: an un-inventoried writer is flagged', () => {
		const synthetic = scanSrc(REPO_ROOT);
		synthetic.identities.push('src/tools/rogue.ts:rogueSettle');
		synthetic.hits.push({
			pattern: 1,
			file: 'src/tools/rogue.ts',
			line: 42,
			identity: 'src/tools/rogue.ts:rogueSettle',
			matched: 'settleDelegationTerminal(',
		});
		expect(censusFindings(synthetic, rows).missingScan).toContain(
			'src/tools/rogue.ts:rogueSettle',
		);
	});

	test('demo: an uncited hit inside an inventoried function is flagged', () => {
		const synthetic = scanSrc(REPO_ROOT);
		const target = 'src/tools/dispatch-lanes.ts:runLane';
		synthetic.hits.push({
			pattern: 1,
			file: 'src/tools/dispatch-lanes.ts',
			line: 9999,
			identity: target,
			matched: 'settleDelegationTerminal(',
		});
		const rogue = censusFindings(synthetic, rows);
		expect(rogue.uncited).toContain(`${target}:9999`);
		expect(
			rogue.missingScan,
			'the identity itself is still inventoried',
		).toEqual([]);
	});

	test('demo: the seam-form sweep call matches and a comment mention never does', () => {
		const seam = scanSource(
			'src/hooks/probe.ts',
			[
				'async function rogueSweep(d: string) {',
				'\tawait _test_exports.sweepStaleDelegationsAsync(d, 1);',
				'}',
			].join('\n'),
		);
		expect(seam.filter((hit) => hit.pattern === 3).length).toBe(1);
		expect(
			scanSource(
				'src/hooks/probe.ts',
				'// settleDelegationTerminal( x\nconst a = 1;\n',
			),
			'a comment mention must never produce a hit',
		).toEqual([]);
	});

	test('demo: identity attribution uses the innermost enclosing declaration', () => {
		const hits = scanSource(
			'src/probe.ts',
			[
				'function neighbour() {}',
				'export function outer() {',
				'  function inner() {',
				'\tawait claimTerminalResult(id, term);',
				'  }',
				'}',
			].join('\n'),
		);
		expect(hits[0]?.identity).toBe('src/probe.ts:inner');
	});
});
