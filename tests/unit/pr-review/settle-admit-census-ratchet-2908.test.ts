/**
 * Settle/admit census ratchet (issue #2908, AC2).
 *
 * Re-runs the census recorded in docs/pr-review-transition-authority.md
 * ("Settle/admit call-site census") against a fresh scan of src/ via
 * tests/helpers/terminal-writer-scanner.ts. Fails CI when a terminal-status
 * writer, settlement trigger, or coverage admission exists in src/ without an
 * inventoried row (or vice versa), when a disposition is not one of the
 * census tokens, or when any row still carries a straggler disposition.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	blankComments,
	payloadIsTerminal,
	SCANNER_PATTERN_COUNT,
	scanSource,
	scanSrc,
} from '../../helpers/terminal-writer-scanner.js';

const REPO_ROOT = path.join(import.meta.dir, '..', '..', '..');
const DOC = path.join(REPO_ROOT, 'docs', 'pr-review-transition-authority.md');

interface CensusRow {
	site: string;
	authority: string;
	rowClass: string;
	disposition: string;
}

function parseCensusRows(): CensusRow[] {
	const text = fs.readFileSync(DOC, 'utf-8').replace(/\r/g, '');
	const lines = text.split('\n');
	const headerIndex = lines.findIndex(
		(line) =>
			line ===
			'| Site | Writes or admits | Authority | Row class | Disposition | Reason |',
	);
	expect(headerIndex).toBeGreaterThanOrEqual(0);
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
		});
	}
	expect(rows.length).toBeGreaterThan(10);
	return rows;
}

describe('settle/admit census ratchet (issue #2908)', () => {
	const scan = scanSrc(REPO_ROOT);
	const rows = parseCensusRows();
	const directPats = new Set([1, 2, 3, 4, 5, 7, 8, 9]);
	const identitiesByClass = new Map<string, string[]>();
	for (const identity of scan.identities) {
		const ownsDirect = scan.hits.some(
			(hit) => hit.identity === identity && directPats.has(hit.pattern),
		);
		const rowClass = ownsDirect ? 'scan' : 'inventory';
		const bucket = identitiesByClass.get(rowClass) ?? [];
		bucket.push(identity);
		identitiesByClass.set(rowClass, bucket);
	}

	test('non-vacuity: the scan covers the real src tree', () => {
		expect(scan.fileCount).toBeGreaterThan(1000);
		expect(SCANNER_PATTERN_COUNT).toBe(9);
		for (let pattern = 1; pattern <= SCANNER_PATTERN_COUNT; pattern += 1) {
			expect(
				scan.hits.filter((hit) => hit.pattern === pattern).length,
				`pattern ${pattern} finds nothing`,
			).toBeGreaterThan(0);
		}
	});

	test('every scanner identity has a census row of the right class', () => {
		const docScanRows = rows
			.filter((row) => row.rowClass === 'scan')
			.map((row) => row.site);
		const docInventoryRows = rows
			.filter((row) => row.rowClass === 'inventory')
			.map((row) => row.site);
		const missingScan = (identitiesByClass.get('scan') ?? []).filter(
			(identity) => !docScanRows.includes(identity),
		);
		const missingInventory = (identitiesByClass.get('inventory') ?? []).filter(
			(identity) => !docInventoryRows.includes(identity),
		);
		expect(missingScan, 'scan identities absent from the census').toEqual([]);
		expect(
			missingInventory,
			'inventory identities absent from the census',
		).toEqual([]);
	});

	test('every scan and inventory census row matches a scanner identity', () => {
		const all = new Set(scan.identities);
		const phantom = rows
			.filter((row) => row.rowClass === 'scan' || row.rowClass === 'inventory')
			.map((row) => row.site)
			.filter((site) => !all.has(site));
		expect(phantom, 'census rows with no scanner identity').toEqual([]);
		const duplicated = rows
			.filter((row) => row.rowClass === 'scan' || row.rowClass === 'inventory')
			.map((row) => row.site)
			.filter((site, index, arr) => arr.indexOf(site) !== index);
		expect(duplicated, 'duplicate census identities').toEqual([]);
	});

	test('dispositions are census tokens and zero rows are stragglers', () => {
		const tokens = new Set(['routed', 'deliberate-second-authority']);
		const bad = rows.filter((row) => !tokens.has(row.disposition));
		expect(
			bad.map((row) => `${row.site}: ${row.disposition}`),
			'dispositions must be routed or deliberate-second-authority',
		).toEqual([]);
		const stragglers = rows.filter((row) => row.disposition === 'straggler');
		expect(
			stragglers,
			'straggler dispositions must be reconciled before merge',
		).toEqual([]);
	});

	test('cross-reference rows point at real authority surfaces', () => {
		const cross = rows.filter((row) => row.rowClass === 'cross-reference');
		expect(cross.length).toBeGreaterThanOrEqual(3);
		const files = cross.map((row) => row.site.split(' ')[0]);
		for (const file of files) {
			expect(
				fs.existsSync(path.join(REPO_ROOT, file)),
				`cross-reference target missing: ${file}`,
			).toBe(true);
		}
	});

	test('demo: an un-inventoried terminal writer is flagged (ratchet bites)', () => {
		const synthetic = [
			'async function rogueSettle(directory: string) {',
			"	await appendDelegationTransition(directory, 'corr-1', {",
			"		status: 'stale',",
			'	});',
			'}',
		].join('\n');
		const hits = scanSource('src/tools/rogue-settle.ts', synthetic);
		expect(hits.filter((hit) => hit.pattern === 4).length).toBe(1);
		expect(hits[0]?.identity).toBe('src/tools/rogue-settle.ts:rogueSettle');
		expect(
			scan.identities.includes('src/tools/rogue-settle.ts:rogueSettle'),
		).toBe(false);
	});

	test('demo: the unregistered seam-form sweep call is also flagged', () => {
		const synthetic = [
			'async function rogueSweep(directory: string) {',
			'	await _test_exports.sweepStaleDelegationsAsync(directory, 1000);',
			'}',
		].join('\n');
		const hits = scanSource('src/hooks/rogue-sweep.ts', synthetic);
		expect(hits.filter((hit) => hit.pattern === 3).length).toBe(1);
	});

	test('demo: a comment mention is not a hit (comment blanking bites)', () => {
		const synthetic = [
			'// settleDelegationTerminal( would appear here if this were code',
			'/* sweepStaleDelegations( and buildTypedDelegationTerminal( too */',
			'async function clean(directory: string) {',
			'	return directory;',
			'}',
		].join('\n');
		expect(scanSource('src/tools/clean-file.ts', synthetic)).toEqual([]);
	});

	test('demo: a non-terminal transition is not a terminal-writer hit', () => {
		const synthetic = [
			'async function launch(directory: string) {',
			"	await appendDelegationTransition(directory, 'corr-2', {",
			"		status: 'running',",
			'	});',
			'}',
		].join('\n');
		const hits = scanSource('src/tools/launch-only.ts', synthetic);
		expect(hits.filter((hit) => hit.pattern === 4).length).toBe(0);
	});

	test('payload classifier: terminal statuses and typed terminals are detected', () => {
		expect(payloadIsTerminal("({ status: 'completed' })")).toBe(true);
		expect(payloadIsTerminal("({ status: 'stale' })")).toBe(true);
		expect(payloadIsTerminal('({ terminalResult: typed })')).toBe(true);
		expect(payloadIsTerminal("({ status: 'running' })")).toBe(false);
		expect(payloadIsTerminal('({ result: launchErrorResult })')).toBe(false);
	});

	test('comment blanker preserves strings and blanks comment bytes only', () => {
		const source = [
			"const a = '// not a comment';",
			'const b = 1; // trailing comment',
			'/* block */ const c = 2;',
			'const d = `template with // and /* inside`;',
		].join('\n');
		const blanked = blankComments(source);
		expect(blanked).toContain("'// not a comment'");
		expect(blanked).toContain('`template with // and /* inside`');
		expect(blanked).not.toContain('trailing comment');
		expect(blanked).not.toContain('block ');
	});
});
