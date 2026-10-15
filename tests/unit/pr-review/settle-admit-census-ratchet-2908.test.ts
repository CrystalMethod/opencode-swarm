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
	// MULTISET, not a set: `new Set(...)` here collapsed two terminal writers
	// on one line into a single census obligation, so a second writer added on
	// a line the census already cited was invisible to the ratchet. Each hit
	// occurrence is one obligation; the doc-side citation list parses with the
	// same occurrence semantics (every `:NNNN` match counts).
	return hits.hits
		.filter((hit) => hit.identity === identity)
		.map((hit) => hit.line)
		.sort((a, b) => a - b);
}

/** Occurrence-aware excess of `a` over `b` (multiset difference). */
function multisetExcess(a: number[], b: number[]): number[] {
	const counts = new Map<number, number>();
	for (const line of b) counts.set(line, (counts.get(line) ?? 0) + 1);
	const excess: number[] = [];
	for (const line of a) {
		const left = counts.get(line) ?? 0;
		if (left > 0) counts.set(line, left - 1);
		else excess.push(line);
	}
	return excess;
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
		// Multiset reconciliation in both directions: each cited `:NNNN`
		// occurrence consumes exactly one actual hit occurrence and vice
		// versa, so a SECOND writer on an already-cited line surfaces as an
		// un-cited hit instead of being absorbed by the existing citation.
		for (const line of multisetExcess(actual, row.hitLines))
			uncited.push(`${row.site}:${line}`);
		for (const line of multisetExcess(row.hitLines, actual))
			stale.push(`${row.site}:${line}`);
	}
	return { missingScan, missingInventory, phantom, uncited, stale };
}

describe('settle/admit census ratchet (issue #2908)', () => {
	// ONE lazily-memoized full scan, shared by every test in this file. A
	// full-tree scan is ~25 s; when the demos each called scanSrc(REPO_ROOT)
	// afresh the file performed three full scans and both demos exceeded
	// bun's default 5 s per-test timeout — the file only passed because CI
	// appends --timeout 120000. The memo is first forced here at describe
	// scope (collection time, not inside any test's timeout budget); the
	// demos below clone it so their synthetic pushes never pollute each
	// other or the shared findings.
	let memoScan: ScanResult | undefined;
	const fullScan = (): ScanResult => {
		memoScan ??= scanSrc(REPO_ROOT);
		return memoScan;
	};
	const cloneScan = (): ScanResult => ({
		...fullScan(),
		hits: [...fullScan().hits],
		identities: [...fullScan().identities],
	});
	const rows = parseCensusRows();
	const findings = censusFindings(fullScan(), rows);

	test('non-vacuity: the scan covers the real src tree with every pattern live', () => {
		const scan = fullScan();
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
		const synthetic = cloneScan();
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
		const synthetic = cloneScan();
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

	test('demo: a SECOND writer on an already-cited line is flagged (multiset reconciliation)', () => {
		// The hole this demo pins: when hit lines were compared as a SET, a
		// second terminal writer added on a line the census already cited
		// produced no new set member, so the ratchet passed. Occurrence-aware
		// comparison must surface it as an un-cited hit.
		const synthetic = cloneScan();
		const target = 'src/tools/dispatch-lanes.ts:runLane';
		const citedLine = rows.find((row) => row.site === target)?.hitLines[0];
		expect(
			citedLine,
			'the runLane row must cite at least one line',
		).toBeDefined();
		synthetic.hits.push({
			pattern: 1,
			file: 'src/tools/dispatch-lanes.ts',
			line: citedLine as number,
			identity: target,
			matched: 'settleDelegationTerminal(',
		});
		const rogue = censusFindings(synthetic, rows);
		expect(rogue.uncited).toContain(`${target}:${citedLine}`);
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

	test('demo: an unresolvable transition payload is censused fail-closed', () => {
		// The hole this demo pins: a transition payload passed as a bare
		// identifier (resolved elsewhere to a terminal) was invisible to the
		// guard. Fail closed — only a payload the scanner can statically
		// resolve to a NON-terminal literal (e.g. `status: 'running'`) stays
		// outside the census.
		const hits = scanSource(
			'src/hooks/probe.ts',
			[
				'async function flip(d: string, id: string, transition: object) {',
				'\tawait appendDelegationTransition(d, id, transition);',
				'\tawait appendDelegationTransition(d, id, { status: "running" });',
				'\tawait appendDelegationTransition(d, id, { status: "stale" });',
				'}',
			].join('\n'),
		).filter((hit) => hit.pattern === 4);
		expect(hits.map((hit) => hit.line)).toEqual([2, 4]);
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
