/**
 * Issue #2700 (AC3) — durable repo guardrail: every terminal-status
 * delegation-record write in the three writer modules is either TYPED
 * (writes `terminalResult` with the flip) or carries an
 * `INTENTIONAL-EVENTLESS:` rationale marker naming why no typed event is
 * attached. Same scan contract as the issue-tracer frozen check C6; the
 * synthetic cases demonstrate the guardrail fires on the original defect
 * shape (an unmarked eventless terminal write) — the base tree's state —
 * and accepts both sanctioned shapes.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const SCANNED_FILES = [
	'src/background/pending-delegations.ts',
	'src/tools/dispatch-lanes.ts',
	'src/background/completion-observer.ts',
] as const;

const TERMINAL_STATUSES = new Set([
	'completed',
	'error',
	'cancelled',
	'stale',
	'consumed',
]);
const LOOKBACK_LINES = 25;

interface Site {
	file: string;
	line: number;
	verdict: 'TYPED' | 'INTENTIONAL' | 'UNMARKED';
}

/** Extract the balanced argument text of a call starting at its '(' index. */
function callSpan(
	text: string,
	openParenIndex: number,
): { callText: string; endOffset: number } {
	let depth = 0;
	let inString: string | null = null;
	for (let i = openParenIndex; i < text.length; i++) {
		const ch = text[i]!;
		if (inString) {
			if (ch === '\\') {
				i++;
				continue;
			}
			if (ch === inString) inString = null;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === '`') {
			inString = ch;
			continue;
		}
		if (ch === '(') depth++;
		if (ch === ')') {
			depth--;
			if (depth === 0) {
				return { callText: text.slice(openParenIndex, i + 1), endOffset: i };
			}
		}
	}
	return { callText: text.slice(openParenIndex), endOffset: text.length - 1 };
}

function firstStatusValue(text: string): string | null {
	const match = /\bstatus\s*:\s*/.exec(text);
	if (!match) return null;
	const rest = text.slice(match.index + match[0].length);
	const value = /^(?:'[^']*'|"[^"]*"|[^,\n}]+)/.exec(rest);
	return value ? value[0]!.trim() : null;
}

function isTerminalStatusToken(token: string): boolean {
	const trimmed = token.trim();
	const quoted = /^(?:'([^']*)'|"([^"]*)")$/.exec(trimmed);
	if (quoted) {
		return TERMINAL_STATUSES.has(quoted[1] ?? quoted[2] ?? '');
	}
	for (const match of trimmed.matchAll(/'([^']*)'|"([^"]*)"/g)) {
		if (TERMINAL_STATUSES.has(match[1] ?? match[2] ?? '')) return true;
	}
	return false;
}

function classifyVerdict(windowText: string): Site['verdict'] {
	if (/\bterminalResult\b/.test(windowText)) return 'TYPED';
	if (/INTENTIONAL-EVENTLESS:/.test(windowText)) return 'INTENTIONAL';
	return 'UNMARKED';
}

function scanContent(display: string, text: string): Site[] {
	const lines = text.split('\n');
	const starts: number[] = [0];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '\n') starts.push(i + 1);
	}
	const lineAt = (index: number): number => {
		let lo = 0;
		let hi = starts.length - 1;
		while (lo < hi) {
			const mid = Math.ceil((lo + hi) / 2);
			if (starts[mid]! <= index) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	};
	const sites: Site[] = [];
	for (const identifier of [
		'appendDelegationTransition',
		'appendRecord',
	] as const) {
		const pattern = new RegExp(`\\b${identifier}\\s*\\(`, 'g');
		for (const match of text.matchAll(pattern)) {
			const openParen = match.index! + match[0]!.length - 1;
			const callLine = lineAt(match.index!);
			const callLineText = lines[callLine] ?? '';
			if (callLineText.includes(`function ${identifier}`)) continue;
			const { callText, endOffset } = callSpan(text, openParen);
			// Same attribution contract as the frozen C6 scanner: transition
			// calls attribute their inline status literal; appendRecord sites
			// attribute the inline literal at the call (pass-through writers
			// whose status is a plain expression are attributed at their
			// callers, which the transition rule scans).
			const statusValue = firstStatusValue(callText);
			if (statusValue === null || !isTerminalStatusToken(statusValue)) continue;
			const windowFrom = Math.max(0, callLine - LOOKBACK_LINES);
			const windowText = lines
				.slice(windowFrom, lineAt(endOffset) + 1)
				.join('\n');
			sites.push({
				file: display,
				line: callLine + 1,
				verdict: classifyVerdict(windowText),
			});
		}
	}
	return sites;
}

describe('issue #2700: eventless terminal-write ratchet', () => {
	it('every terminal-status record write in the writer modules is typed or marked', () => {
		const sites: Site[] = [];
		for (const file of SCANNED_FILES) {
			const absolute = path.resolve(import.meta.dir, '../../../', file);
			sites.push(...scanContent(file, readFileSync(absolute, 'utf8')));
		}
		expect(sites.length).toBeGreaterThan(0);
		const unmarked = sites.filter((site) => site.verdict === 'UNMARKED');
		expect(unmarked.map((site) => `${site.file}:${site.line}`)).toEqual([]);
	});

	it('the guardrail fires on the original defect shape (unmarked eventless write)', () => {
		const buggy = [
			'async function sweepStaleAsyncLaneRecords(dir, record, now) {',
			'\tappendRecord(dir, {',
			'\t\t...record,',
			"\t\tstatus: 'stale',",
			'\t\tupdatedAt: now,',
			'\t\tresult: livenessResult,',
			'\t});',
			'}',
		].join('\n');
		const sites = scanContent('synthetic.ts', buggy);
		expect(sites).toHaveLength(1);
		expect(sites[0]?.verdict).toBe('UNMARKED');
	});

	it('the guardrail accepts the typed and intentional shapes', () => {
		const typed = [
			'\tappendRecord(dir, {',
			'\t\t...record,',
			"\t\tstatus: 'stale',",
			'\t\tterminalResult: staleTerminal,',
			'\t});',
		].join('\n');
		const intentional = [
			'\t// INTENTIONAL-EVENTLESS: post-claim terminal-to-terminal flip;',
			'\t// the record carries its typed event from the preceding claim.',
			"\tawait appendDelegationTransition(dir, id, { status: 'stale' });",
		].join('\n');
		expect(scanContent('typed.ts', typed).map((site) => site.verdict)).toEqual([
			'TYPED',
		]);
		expect(
			scanContent('intentional.ts', intentional).map((site) => site.verdict),
		).toEqual(['INTENTIONAL']);
	});
});
