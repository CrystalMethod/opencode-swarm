/**
 * Terminal-writer scanner for the settle/admit call-site census (issue #2908).
 *
 * Pure text scan over the src tree (all .ts files) that enumerates every call
 * site able to
 * write a terminal delegation status, trigger a lane settlement, or admit
 * PR-review coverage. Source is comment-blanked before matching so a mention
 * inside a comment can never satisfy the census. Hits are attributed to the
 * nearest enclosing NAMED function declaration (const-arrow handlers are not
 * identities; a hit with no enclosing named function attributes to the module
 * top level) and aggregated into `file:function` identities.
 *
 * Patterns (mirrors docs/pr-review-transition-authority.md "Settle/admit
 * call-site census"):
 *   1 settleDelegationTerminal( call sites (definition excluded)
 *   2 claimTerminalResult( call sites (definition excluded)
 *   3 sweep invocations in any textual form — sweepStaleDelegations(,
 *     sweepStaleLocked(, and the _test_exports seam form
 *     sweepStaleDelegationsAsync( (definitions excluded)
 *   4 appendDelegationTransition( calls whose balanced argument object carries
 *     a terminal status literal or a terminalResult: key
 *   5 buildTypedDelegationTerminal( construction sites (definition excluded)
 *   6 appendRecord( sites, scoped to src/background/pending-delegations.ts
 *     (the delegation store's raw writer; cross-module appendRecord homonyms
 *     belong to other subsystems)
 *   7 settlePresumedStalePrWorkflowLanes( trigger call sites (definition and
 *     re-export lines excluded)
 *   8 admission-sink references — admitPrReviewPartialBaseCoverage,
 *     rollbackPrReviewPartialBaseCoverageAdmission,
 *     persistVerdictSettlementReceipt (definitions AND call sites)
 *
 * Disclosed boundary (same class as the eventless-terminal-write-ratchet-2700
 * precedent): a text scanner cannot see dynamic-dispatch aliases, so a writer
 * routed through an alias variable escapes every pattern above. The census
 * table plus this scan still close every statically visible call shape.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const TERMINAL_STATUS_LITERALS = [
	'completed',
	'error',
	'cancelled',
	'stale',
	'consumed',
] as const;

export const SCANNER_ROOT = 'src';
const P6_FILE = 'src/background/pending-delegations.ts';
const MODULE_IDENTITY = '<module>';

export interface ScanHit {
	pattern: number;
	file: string;
	line: number;
	identity: string;
	matched: string;
}

export interface ScanResult {
	fileCount: number;
	hits: ScanHit[];
	identities: string[];
}

interface PatternDef {
	pattern: number;
	regex: RegExp;
	fileFilter?: (file: string) => boolean;
	payloadCheck?: boolean;
}

const CALLEE_EXCLUDING_DEFINITION =
	'(?<![\\w$.])(?:%NAMES%)\\s*\\((?=[^)]*\\))?';

const PATTERNS: PatternDef[] = [
	{ pattern: 1, regex: /(?<!function )settleDelegationTerminal\s*\(/g },
	{ pattern: 2, regex: /(?<!function )claimTerminalResult\s*\(/g },
	{
		pattern: 3,
		regex:
			/(?<!function )(?:sweepStaleDelegations|sweepStaleLocked|sweepStaleDelegationsAsync)\s*\(/g,
	},
	{
		pattern: 4,
		regex: /(?<!function )appendDelegationTransition\s*\(/g,
		payloadCheck: true,
	},
	{ pattern: 5, regex: /(?<!function )buildTypedDelegationTerminal\s*\(/g },
	{
		pattern: 6,
		regex: /(?<!function )appendRecord\s*\(/g,
		fileFilter: (file) => file.replaceAll('\\', '/') === P6_FILE,
	},
	{
		pattern: 7,
		regex: /(?<!function )settlePresumedStalePrWorkflowLanes\s*\(/g,
	},
	{
		pattern: 8,
		regex:
			/(?<!function )(?:admitPrReviewPartialBaseCoverage|rollbackPrReviewPartialBaseCoverageAdmission|persistVerdictSettlementReceipt)\s*\(/g,
	},
];

/**
 * Replace every comment byte with a space so comment text can never match.
 * Tracks single/double/template strings and regex literals (division-vs-regex
 * disambiguated by the previous significant character, the standard heuristic)
 * so a `//` inside a string or regex is not mistaken for a line comment.
 */
export function blankComments(source: string): string {
	let out = '';
	let mode:
		| 'code'
		| 'line'
		| 'block'
		| 'single'
		| 'double'
		| 'template'
		| 'regex' = 'code';
	let prevSignificant = '';
	for (let i = 0; i < source.length; i += 1) {
		const c = source[i];
		const next = source[i + 1];
		if (mode === 'code') {
			if (c === '/' && next === '/') {
				mode = 'line';
				out += '  ';
				i += 1;
				continue;
			}
			if (c === '/' && next === '*') {
				mode = 'block';
				out += '  ';
				i += 1;
				continue;
			}
			if (c === "'") {
				mode = 'single';
			} else if (c === '"') {
				mode = 'double';
			} else if (c === '`') {
				mode = 'template';
			} else if (c === '/') {
				const regexContext =
					prevSignificant === '' ||
					/[({[=,;:!&|?+\-*%<>~^]/.test(prevSignificant) ||
					/\b(?:return|typeof|case|in|of|new|delete|void|do|else)\s$/.test(
						out.slice(-12),
					);
				if (regexContext) {
					mode = 'regex';
					out += c;
					prevSignificant = c;
					continue;
				}
			}
			out += c;
			if (!/\s/.test(c)) prevSignificant = c;
			continue;
		}
		if (mode === 'line') {
			if (c === '\n' || c === '\r') {
				mode = 'code';
				out += c;
			} else {
				out += ' ';
			}
			continue;
		}
		if (mode === 'block') {
			if (c === '*' && next === '/') {
				mode = 'code';
				out += '  ';
				i += 1;
			} else {
				out += c === '\n' || c === '\r' ? c : ' ';
			}
			continue;
		}
		// string / template / regex literal: emit verbatim, watch terminators.
		const isTemplate = mode === 'template';
		if (c === '\\' && next !== undefined) {
			out += c + next;
			i += 1;
			continue;
		}
		if (
			(mode === 'single' && c === "'") ||
			(mode === 'double' && c === '"') ||
			(isTemplate && c === '`') ||
			(mode === ('regex' as never) &&
				c === '/' &&
				!/[[(\\]/.test(source[i - 1] ?? ''))
		) {
			mode = 'code';
			prevSignificant = c;
		}
		out += c;
	}
	return out;
}

const NAMED_FUNCTION =
	/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/;

/** `file:function` for the nearest enclosing named declaration, or `file:<module>`. */
export function identityForLine(
	file: string,
	blankedLines: string[],
	lineIndex: number,
): string {
	for (let i = lineIndex; i >= 0; i -= 1) {
		const m = NAMED_FUNCTION.exec(blankedLines[i]);
		if (m) return `${file}:${m[1]}`;
	}
	return `${file}:${MODULE_IDENTITY}`;
}

function balancedCallSpan(
	source: string,
	openParenIndex: number,
): { text: string; end: number } {
	let depth = 0;
	for (let i = openParenIndex; i < source.length; i += 1) {
		const c = source[i];
		if (c === '(') depth += 1;
		else if (c === ')') {
			depth -= 1;
			if (depth === 0)
				return { text: source.slice(openParenIndex, i + 1), end: i };
		}
	}
	return { text: source.slice(openParenIndex), end: source.length - 1 };
}

export function payloadIsTerminal(span: string): boolean {
	if (/\bterminalResult\s*:/.test(span)) return true;
	return TERMINAL_STATUS_LITERALS.some((status) =>
		new RegExp(
			`["']${status}["']\\s*[,}]|status\\s*:\\s*["']${status}["']`,
		).test(span),
	);
}

export function listSrcFiles(rootDir: string): string[] {
	const out: string[] = [];
	const walk = (abs: string) => {
		for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
			const child = path.join(abs, entry.name);
			if (entry.isDirectory()) walk(child);
			else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(child);
		}
	};
	walk(path.join(rootDir, SCANNER_ROOT));
	out.sort();
	return out;
}

export function scanSource(file: string, source: string): ScanHit[] {
	const blanked = blankComments(source);
	const lines = blanked.split('\n');
	const lineStarts: number[] = [0];
	for (const line of lines)
		lineStarts.push(lineStarts[lineStarts.length - 1] + line.length + 1);
	const lineOf = (offset: number): number => {
		let lo = 0;
		let hi = lineStarts.length - 2;
		while (lo < hi) {
			const mid = Math.ceil((lo + hi) / 2);
			if (lineStarts[mid] <= offset) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	};
	const hits: ScanHit[] = [];
	for (const def of PATTERNS) {
		if (def.fileFilter && !def.fileFilter(file)) continue;
		def.regex.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = def.regex.exec(blanked)) !== null) {
			if (def.payloadCheck) {
				const openParen = m.index + m[0].length - 1;
				const span = balancedCallSpan(blanked, openParen);
				if (!payloadIsTerminal(span.text)) continue;
			}
			const line = lineOf(m.index);
			hits.push({
				pattern: def.pattern,
				file,
				line: line + 1,
				identity: identityForLine(file, lines, line),
				matched: m[0].trim(),
			});
		}
	}
	return hits;
}

export function scanSrc(rootDir: string): ScanResult {
	const files = listSrcFiles(rootDir);
	const hits: ScanHit[] = [];
	for (const abs of files) {
		const rel = path.relative(rootDir, abs).replaceAll('\\', '/');
		hits.push(...scanSource(rel, fs.readFileSync(abs, 'utf-8')));
	}
	const identitySet = new Set(hits.map((hit) => hit.identity));
	return {
		fileCount: files.length,
		hits,
		identities: [...identitySet].sort(),
	};
}

export const SCANNER_PATTERN_COUNT = PATTERNS.length;

export const _internals = { PATTERNS, CALLEE_EXCLUDING_DEFINITION };
