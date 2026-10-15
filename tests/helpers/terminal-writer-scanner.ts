/**
 * Terminal-writer scanner for the settle/admit call-site census (issue #2908).
 *
 * Pure text scan over the src tree that enumerates every call site able to
 * write a terminal delegation status, trigger a lane settlement, or admit
 * PR-review coverage. The source is lexed (comments blanked, literal bodies
 * excluded) before matching, so a mention inside a comment can never satisfy
 * the census. Hits are attributed to the innermost ENCLOSING named function
 * declaration by brace-depth span tracking, and aggregated into
 * `file:function` identities.
 *
 * Patterns (mirrors docs/pr-review-transition-authority.md "Settle/admit
 * call-site census"):
 *   1  settleDelegationTerminal( call sites (definition excluded)
 *   2  claimTerminalResult( call sites (definition excluded)
 *   3  sweep invocations in any textual form - sweepStaleDelegations(,
 *      sweepStaleLocked(, and the _test_exports seam form
 *      sweepStaleDelegationsAsync(
 *   4  appendDelegationTransition( calls whose balanced argument object carries
 *      a terminal status literal or a terminalResult: key — plus, FAIL CLOSED,
 *      calls whose payload status the scanner cannot statically resolve to a
 *      literal (a bare identifier argument like
 *      `appendDelegationTransition(dir, id, transition)` is censused as a
 *      potential terminal writer; only a payload resolving to a non-terminal
 *      literal such as `{ status: 'running' }` stays excluded)
 *   5  buildTypedDelegationTerminal( construction sites (definition excluded)
 *   6  appendRecord( sites, scoped to the delegation store
 *      (src/background/pending-delegations.ts) - its raw record writer
 *   7  settlePresumedStalePrWorkflowLanes( trigger call sites
 *      (definition and re-export lines excluded)
 *   8  admission-sink references - admitPrReviewPartialBaseCoverage,
 *      admitPrReviewPartialBaseCoverageFromCompletion (the completion-module
 *      alias the gate's module-scope wrapper dispatches to),
 *      rollbackPrReviewPartialBaseCoverageAdmission,
 *      persistVerdictSettlementReceipt (definitions AND call sites)
 *   9  writeDelegationShadowProjection( - the coordination shadow projection,
 *      a whole-ledger terminal-bearing raw writer (definitions AND call sites)
 *  10  compactDelegationsLocked( - the checkpoint/ledger compaction writer,
 *      the second whole-ledger terminal-bearing raw writer (definitions AND
 *      call sites)
 *
 * Disclosed boundaries (the census states the same list):
 *   - dynamic-dispatch aliases: a writer routed through an alias variable
 *     (`const s = settleDelegationTerminal`) is invisible to a text scanner.
 *   - a class method or const-arrow handler has no named-function declaration
 *     of its own, so it attributes to its nearest enclosing named function
 *     (or `<module>` at top level); a NEW writer there is caught by the
 *     census ratchet's per-row hit-line reconciliation, not by identity.
 *   - symlinked source entries are skipped (never read, never diagnosed);
 *     the store is tracked without symlinks today.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

export const TERMINAL_STATUS_LITERALS = [
	'completed',
	'error',
	'cancelled',
	'stale',
	'consumed',
] as const;

/** The non-terminal members of `BackgroundDelegationStatus` (src/background). */
export const NON_TERMINAL_STATUS_LITERALS = [
	'pending',
	'running',
	'ingesting',
	'ingestion_error',
	'rejected',
] as const;

export const SCANNER_ROOT = 'src';
const P6_FILE = 'src/background/pending-delegations.ts';
const MODULE_IDENTITY = '<module>';
const MAX_SCAN_BYTES = 4 * 1024 * 1024;
const MAX_WALK_DEPTH = 32;

export interface ScanHit {
	pattern: number;
	file: string;
	line: number;
	identity: string;
	matched: string;
}

export interface ScanResult {
	fileCount: number;
	skippedFiles: string[];
	depthLimited: boolean;
	hits: ScanHit[];
	identities: string[];
}

export interface NamedFunctionSpan {
	name: string;
	start: number;
	end: number;
}

interface PatternDef {
	pattern: number;
	regex: RegExp;
	fileFilter?: (file: string) => boolean;
	payloadCheck?: boolean;
}

export const PATTERNS: PatternDef[] = [
	{ pattern: 1, regex: /(?<!function )settleDelegationTerminal\s*\(/g },
	// `claimTerminalResult` is the terminal-claim AUTHORITY itself, so its own
	// definition must own a census row (issue #2908 PRR-040) — no
	// definition-excluding lookbehind, for the same reason pattern 8 has none.
	{ pattern: 2, regex: /claimTerminalResult\s*\(/g },
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
	{
		pattern: 5,
		regex: /(?<!function )buildTypedDelegationTerminal\s*\(/g,
	},
	{
		pattern: 6,
		regex: /(?<!function )appendRecord\s*\(/g,
		fileFilter: (file) => file === P6_FILE,
	},
	{
		pattern: 7,
		regex: /(?<!function )settlePresumedStalePrWorkflowLanes\s*\(/g,
	},
	{
		pattern: 8,
		regex:
			/(?:admitPrReviewPartialBaseCoverageFromCompletion|admitPrReviewPartialBaseCoverage|rollbackPrReviewPartialBaseCoverageAdmission|persistVerdictSettlementReceipt)\s*\(/g,
	},
	{ pattern: 9, regex: /writeDelegationShadowProjection\s*\(/g },
	{ pattern: 10, regex: /compactDelegationsLocked\s*\(/g },
];

type LexMode =
	| 'code'
	| 'line'
	| 'block'
	| 'single'
	| 'double'
	| 'template'
	| 'regex';

// `+ - * %` are NOT regex-context characters: a trailing `++`/`--`/`*=`/`%=`
// is arithmetic or assignment, so `a++ / b` is division (issue #2908 PRR-031).
const REGEX_CONTEXT_OPERATORS = /[({[=,;:!&|?<>~^]/;
const REGEX_CONTEXT_KEYWORDS =
	/\b(?:return|typeof|case|in|of|new|delete|void|do|else|await|yield)$/;

/** Index of the `/` that closes a regex literal starting at `from`, or -1. */
function regexLiteralEnd(source: string, from: number): number {
	let i = from + 1;
	while (i < source.length) {
		const c = source[i];
		if (c === '\\') {
			i += 2;
			continue;
		}
		if (c === '[') {
			// A `/` inside a character class does not close the literal.
			i += 1;
			while (i < source.length && source[i] !== ']') {
				i += source[i] === '\\' ? 2 : 1;
			}
			i += 1;
			continue;
		}
		if (c === '/') return i;
		if (c === '\n') return -1;
		i += 1;
	}
	return -1;
}

/**
 * Blank comment bytes (preserving newlines and length) and exclude string,
 * template, and regex literal bodies from code matching. Template literals
 * keep a `${}` substitution stack so a backtick inside a substitution cannot
 * close the outer template and comment syntax inside a substitution is lexed
 * as code (issue #2908 PRR-005). Regex literals are consumed whole — including
 * the `/\\/g` idiom, whose closing slash follows an escaped backslash
 * (issue #2908 PRR-003) — and the division-vs-regex heuristic accepts a
 * keyword before arbitrary whitespace or a line break
 * (issue #2908 PRR-004).
 */
export function blankLiteralsAndComments(source: string): string {
	let out = '';
	// Frames model template `${...}` substitutions (issue #2908 PRR-005): the
	// substitution is lexed as code and the frame is popped when its closing
	// brace returns to the template, so a nested backtick inside `${...}`
	// cannot close the outer template.
	const frames: { mode: LexMode; depth: number }[] = [
		{ mode: 'code', depth: 0 },
	];
	let prevSignificant = '';
	let atLineStart = true;
	let depth = 0;
	const mode = (): LexMode => frames[frames.length - 1].mode;
	const setMode = (next: LexMode) => {
		frames[frames.length - 1].mode = next;
	};
	for (let i = 0; i < source.length; i += 1) {
		const c = source[i];
		const next = source[i + 1];
		const current = mode();
		if (current === 'code') {
			if (c === '\n') {
				atLineStart = true;
				out += c;
				continue;
			}
			if (c === '/' && next === '/') {
				setMode('line');
				out += '  ';
				i += 1;
				continue;
			}
			if (c === '/' && next === '*') {
				setMode('block');
				out += '  ';
				i += 1;
				continue;
			}
			if (c === "'") {
				setMode('single');
			} else if (c === '"') {
				setMode('double');
			} else if (c === '`') {
				setMode('template');
			} else if (c === '{') {
				depth += 1;
			} else if (c === '}') {
				if (depth === 0 && frames.length > 1) {
					frames.pop();
					out += c;
					atLineStart = false;
					continue;
				}
				depth -= 1;
			} else if (c === '/') {
				const tail = out.replace(/\s+$/, '');
				const regexContext =
					prevSignificant === '' ||
					REGEX_CONTEXT_OPERATORS.test(prevSignificant) ||
					REGEX_CONTEXT_KEYWORDS.test(tail);
				if (regexContext) {
					const close = regexLiteralEnd(source, i);
					if (close !== -1) {
						out += source.slice(i, close + 1);
						prevSignificant = source[close];
						i = close;
						atLineStart = false;
						continue;
					}
				}
			}
			out += c;
			if (!/\s/.test(c)) {
				prevSignificant = c;
				atLineStart = false;
			}
			continue;
		}
		if (current === 'line') {
			if (c === '\n' || c === '\r') {
				setMode('code');
				out += c;
			} else {
				out += ' ';
			}
			continue;
		}
		if (current === 'block') {
			if (c === '*' && next === '/') {
				setMode('code');
				out += '  ';
				i += 1;
			} else {
				out += c === '\n' || c === '\r' ? c : ' ';
			}
			continue;
		}
		// string / template / regex literal
		if (c === '\\' && next !== undefined) {
			out += c + next;
			i += 1;
			continue;
		}
		if (current === 'single' && c === "'") {
			setMode('code');
			prevSignificant = c;
		} else if (current === 'double' && c === '"') {
			setMode('code');
			prevSignificant = c;
		} else if (current === 'template') {
			if (c === '`') {
				setMode('code');
				prevSignificant = c;
			} else if (c === '$' && next === '{') {
				out += '${';
				frames.push({ mode: 'code', depth: 0 });
				i += 1;
				continue;
			}
		}
		out += c;
	}
	return out;
}

/**
 * Span every named function declaration over the source using the TypeScript
 * AST, so attribution picks the innermost ENCLOSING declaration
 * (issue #2908 PRR-027) without depending on a hand-rolled brace counter.
 *
 * A brace-depth implementation was tried first and silently mis-attributed
 * every hit in src/background/pending-delegations.ts to one neighbour: a
 * single unbalanced construct swallowed the rest of the file — exactly the
 * failure mode a census guardrail must not have. The AST also handles inline
 * object-type parameters, multi-line signatures, and class or arrow bodies
 * that a line-anchored regex cannot see.
 */
export function collectNamedFunctionSpans(source: string): NamedFunctionSpan[] {
	const spans: NamedFunctionSpan[] = [];
	const file = ts.createSourceFile(
		'scan.ts',
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const visit = (node: ts.Node): void => {
		if (
			ts.isFunctionDeclaration(node) &&
			node.name !== null &&
			node.body !== undefined
		) {
			spans.push({
				name: node.name.text,
				start: node.body.getStart(file),
				end: node.body.end,
			});
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return spans;
}

/** `file:function` for the innermost named declaration enclosing `offset`. */
export function identityForOffset(
	file: string,
	spans: NamedFunctionSpan[],
	offset: number,
): string {
	let best: NamedFunctionSpan | null = null;
	for (const span of spans) {
		if (offset < span.start || offset > span.end) continue;
		if (best === null || span.start > best.start) best = span;
	}
	return `${file}:${best ? best.name : MODULE_IDENTITY}`;
}

/** Kept for callers that only need the blanked text (issue #2908 PRR-003). */
export function blankComments(source: string): string {
	return blankLiteralsAndComments(source);
}

/**
 * Balanced call-argument span, skipping string/template/regex literal bodies
 * so a paren inside a message cannot shift the depth
 * (issue #2908 PRR-032). Falls back to the rest of the line when the call
 * does not close on it, which is the conservative direction for a guardrail.
 */
export function balancedCallSpan(
	source: string,
	openParenIndex: number,
): { text: string; end: number } {
	let depth = 0;
	for (let i = openParenIndex; i < source.length; i += 1) {
		const c = source[i];
		if (c === '\\') {
			i += 1;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			const close = stringLiteralEnd(source, i);
			if (close === -1) break;
			i = close;
			continue;
		}
		if (c === '(') depth += 1;
		else if (c === ')') {
			depth -= 1;
			if (depth === 0)
				return { text: source.slice(openParenIndex, i + 1), end: i };
		}
	}
	const lineEnd = source.indexOf('\n', openParenIndex);
	const end = lineEnd === -1 ? source.length : lineEnd;
	return { text: source.slice(openParenIndex, end), end };
}

function stringLiteralEnd(source: string, from: number): number {
	const quote = source[from];
	for (let i = from + 1; i < source.length; i += 1) {
		const c = source[i];
		if (c === '\\') {
			i += 1;
			continue;
		}
		if (c === quote) return i;
		if (c === '\n' && quote !== '`') return -1;
	}
	return -1;
}

export function payloadIsTerminal(span: string): boolean {
	if (/\bterminalResult\s*:/.test(span)) return true;
	return TERMINAL_STATUS_LITERALS.some((status) =>
		new RegExp(
			`["']${status}["']\\s*[,}]|status\\s*:\\s*["']${status}["']`,
		).test(span),
	);
}

/**
 * True when the balanced call span statically resolves the payload's status
 * to a string LITERAL — a `status: "..."` key, or a standalone known-status
 * literal in the value shape `payloadIsTerminal` recognizes — whatever the
 * literal's value (terminal or not). A payload carrying neither, such as a
 * bare identifier argument (`appendDelegationTransition(dir, id,
 * transition)`), a variable, or a computed object, is UNRESOLVABLE by a
 * text scanner; the census fails closed on it and inventories the call as a
 * potential terminal writer (issue #2908: only a payload that provably
 * resolves to a non-terminal literal like `{ status: 'running' }` stays
 * excluded).
 */
export function payloadResolvesToLiteralStatus(span: string): boolean {
	if (/\bstatus\s*:\s*["'][^"']+["']/.test(span)) return true;
	return [...TERMINAL_STATUS_LITERALS, ...NON_TERMINAL_STATUS_LITERALS].some(
		(status) => new RegExp(`["']${status}["']\\s*[,}]`).test(span),
	);
}

export function listSrcFiles(rootDir: string): {
	files: string[];
	depthLimited: boolean;
} {
	const files: string[] = [];
	let depthLimited = false;
	const walk = (abs: string, depth: number): void => {
		if (depth > MAX_WALK_DEPTH) {
			depthLimited = true;
			return;
		}
		for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
			const child = path.join(abs, entry.name);
			if (entry.isDirectory()) walk(child, depth + 1);
			else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(child);
		}
	};
	walk(path.join(rootDir, SCANNER_ROOT), 0);
	files.sort();
	return { files, depthLimited };
}

export function scanSource(file: string, source: string): ScanHit[] {
	const blanked = blankLiteralsAndComments(source);
	const spans = collectNamedFunctionSpans(source);
	const lineStarts: number[] = [0];
	for (const line of blanked.split('\n')) {
		lineStarts.push(lineStarts[lineStarts.length - 1] + line.length + 1);
	}
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
				// Fail closed: a terminal-carrying payload hits, and so does a
				// payload whose status cannot be statically resolved to a
				// literal (a bare identifier can smuggle a terminal past the
				// census). Only a payload that resolves to a NON-terminal
				// literal (e.g. `{ status: 'running' }`) stays excluded.
				if (
					!payloadIsTerminal(span.text) &&
					payloadResolvesToLiteralStatus(span.text)
				) {
					continue;
				}
			}
			hits.push({
				pattern: def.pattern,
				file,
				line: lineOf(m.index) + 1,
				identity: identityForOffset(file, spans, m.index),
				matched: m[0].trim(),
			});
		}
	}
	return hits;
}

export function scanSrc(rootDir: string): ScanResult {
	const { files, depthLimited } = listSrcFiles(rootDir);
	const hits: ScanHit[] = [];
	const skippedFiles: string[] = [];
	for (const abs of files) {
		const rel = path.relative(rootDir, abs).replaceAll('\\', '/');
		const stat = fs.statSync(abs);
		if (stat.size > MAX_SCAN_BYTES) {
			skippedFiles.push(rel);
			continue;
		}
		hits.push(...scanSource(rel, fs.readFileSync(abs, 'utf-8')));
	}
	const identitySet = new Set(hits.map((hit) => hit.identity));
	return {
		fileCount: files.length - skippedFiles.length,
		skippedFiles,
		depthLimited,
		hits,
		identities: [...identitySet].sort(),
	};
}

export const SCANNER_PATTERN_COUNT = PATTERNS.length;
