#!/usr/bin/env bun
/**
 * Pending release-fragment gate — enforces the AGENTS.md mandate:
 *
 *   "Every user-visible PR ships a `docs/releases/pending/<unique-slug>.md`
 *    fragment (mandatory — see `contributing.md`)."
 *
 * Release-please aggregates those fragments into the GitHub Release body
 * (scripts/release-notes-fragments.mjs). A user-visible PR that ships
 * WITHOUT a fragment is silently omitted from the release notes forever —
 * this gate makes that omission a CI failure instead of a silent gap.
 *
 * Classification lives in scripts/user-visible-paths.ts — the single
 * declarative path-class table (issue #2955). This module re-exports the
 * pure classifiers so existing imports keep working; do NOT add path rules
 * here.
 *
 * Pass conditions (any one):
 *   - The diff touches NO user-visible surface (chore/test/docs-only PR).
 *   - The diff ADDS at least one file under docs/releases/pending/ ending
 *     in .md (the mandate satisfied in the same PR). Added-only by design
 *     (FRAGMENT_SATISFACTION in user-visible-paths.ts).
 *
 * Escape hatch: FRAGMENT_CHECK_ENFORCE=0|false|no|off soft-warns (prints
 * the violation, exits 0) — same convention as TEST_CAP_ENFORCE, for a
 * deliberate exception PR. The escape hatch does NOT apply to
 * --print-requirement (a classification probe for workflow consumers; the
 * caller owns its messaging and exit handling).
 *
 * Machine-readable mode for workflow consumers (issue #2955, transport
 * hardening in issue #3290):
 *   bun scripts/check-pending-fragment.ts --print-requirement [--added <path>]...
 *     - reads the CHANGED path list from stdin (one path per line)
 *   bun scripts/check-pending-fragment.ts --print-requirement
 *     --paths-format <newline|nul|jsonl>
 *     --changed-file <path> --added-file <path>
 *     - reads both lists from files in the given framing (issue #3290: a
 *       line-delimited transport cannot represent a path containing a
 *       newline, and `core.quotePath=false` still C-quotes quote/backslash/
 *       control characters; `nul` matches `git diff -z` output verbatim and
 *       `jsonl` carries one JSON-encoded path string per line, which handles
 *       every character by construction)
 *   - `--added` together with `--added-file` is a usage error (both name the
 *     ADDED list — ambiguity is refused). When `--changed-file` is present,
 *     stdin is simply not read (documented precedence: callers that pipe
 *     stdin anyway get no error and no effect).
 *   - prints exactly one line: required=<true|false> satisfied=<true|false>
 *   - exit 0 = no violation (not required OR satisfied)
 *   - exit 1 = required AND not satisfied
 *   - exit 2 = usage error, undecodable input, or input over the byte bound
 *   - every input read is STREAM-bounded at MAX_LIST_BYTES: stdin is consumed
 *     incrementally and stops after the bound, so an endless stream cannot
 *     pin the process (issue #3290 A3).
 *   Pure: no git, no repo-root resolution, no env enforcement.
 *
 * Portability: TypeScript + Bun only (issue #2078 — no new Bash gates).
 * Pure classification logic is exported for unit tests.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	FRAGMENT_DIR,
	FRAGMENT_SATISFACTION,
	isPendingFragment,
	isUserVisiblePath,
} from './user-visible-paths';

export { FRAGMENT_DIR, isPendingFragment, isUserVisiblePath };

const GIT_TIMEOUT_MS = 30_000;

export interface FragmentCheckInput {
	/** Root-relative paths changed (added/modified/deleted) in the PR. */
	changedFiles: string[];
	/** Root-relative paths ADDED in the PR (subset of changedFiles). */
	addedFiles: string[];
}

export interface FragmentCheckResult {
	violation: boolean;
	message: string;
}

/**
 * Pure gate evaluation. A violation exists when the diff touches at least
 * one user-visible surface AND adds no pending fragment. Deletions under
 * docs/releases/pending/ do NOT satisfy the mandate (the new narrative must
 * exist for the new release).
 */
export function evaluateFragmentCheck(
	input: FragmentCheckInput,
): FragmentCheckResult {
	const visible = input.changedFiles.filter(isUserVisiblePath);
	const fragmentAdded = input.addedFiles.some(isPendingFragment);
	if (visible.length === 0 || fragmentAdded) {
		return {
			violation: false,
			message:
				visible.length === 0
					? 'no user-visible surfaces touched — fragment not required'
					: `pending fragment present (${input.addedFiles.filter(isPendingFragment).join(', ')})`,
		};
	}
	const shown = visible.slice(0, 8).join(', ');
	const more = visible.length > 8 ? ` (+${visible.length - 8} more)` : '';
	return {
		violation: true,
		message:
			`user-visible surfaces touched (${shown}${more}) but no file was added under ${FRAGMENT_DIR}/. ` +
			'AGENTS.md mandates a docs/releases/pending/<unique-slug>.md fragment for every user-visible PR — ' +
			'release-please aggregates fragments into the GitHub Release body, so a missing fragment means this ' +
			"PR's changes ship with no release notes. Add the fragment, or set FRAGMENT_CHECK_ENFORCE=0 for a deliberate exception.",
	};
}

export interface RequirementVerdict {
	/** Does the changed list contain at least one user-visible path? */
	required: boolean;
	/** Does the added list contain a pending fragment (added-only semantics)? */
	satisfied: boolean;
	/** required && !satisfied — the gate-violation predicate. */
	violation: boolean;
}

/**
 * Pure requirement evaluation backing --print-requirement. Same core as
 * evaluateFragmentCheck, expressed for machine consumers that branch on the
 * verdict themselves (workflow arms).
 *
 * FRAGMENT_SATISFACTION is load-bearing here, not documentation: the
 * 'added-only' policy is what makes `satisfied` a function of the ADDED list
 * alone (a modified or deleted pending fragment does not satisfy the
 * mandate). Deleting or flipping the constant changes this verdict, which
 * the parity suite pins.
 */
export function evaluateRequirement(
	changedFiles: readonly string[],
	addedFiles: readonly string[],
): RequirementVerdict {
	const required = changedFiles.some(isUserVisiblePath);
	const satisfied =
		FRAGMENT_SATISFACTION === 'added-only' && addedFiles.some(isPendingFragment);
	return { required, satisfied, violation: required && !satisfied };
}

export function resolveEnforce(raw: string | undefined): boolean {
	if (raw === undefined) return true;
	return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

/** Repo-root resolution identical to check-test-file-cap.ts. */
export function resolveRepoRoot(cwd: string): string {
	let proc: ReturnType<typeof Bun.spawnSync>;
	try {
		proc = Bun.spawnSync({
			cmd: ['git', 'rev-parse', '--show-toplevel'],
			cwd,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: GIT_TIMEOUT_MS,
		});
	} catch {
		return cwd;
	}
	if (proc.exitCode !== 0) return cwd;
	const trimmed = proc.stdout.toString().trim();
	return trimmed.length > 0 ? path.resolve(trimmed) : cwd;
}

const BASE_BRANCH_CANDIDATES = ['origin/main', 'main'];

function runGit(
	args: string[],
	cwd: string,
): { exitCode: number; stdout: string } {
	try {
		const proc = Bun.spawnSync({
			cmd: ['git', ...args],
			cwd,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: GIT_TIMEOUT_MS,
		});
		return { exitCode: proc.exitCode ?? 1, stdout: proc.stdout.toString() };
	} catch {
		return { exitCode: 1, stdout: '' };
	}
}

function splitNulList(raw: string): string[] {
	return raw.split('\0').filter((entry) => entry.length > 0);
}

export function main(startDir: string = process.cwd()): number {
	const cwd = resolveRepoRoot(startDir);
	let baseBranch: string | null = null;
	for (const branch of BASE_BRANCH_CANDIDATES) {
		if (runGit(['rev-parse', branch], cwd).exitCode === 0) {
			baseBranch = branch;
			break;
		}
	}

	let changedFiles: string[] = [];
	let addedFiles: string[] = [];
	if (baseBranch) {
		// Merge-base-relative diff (BOT-H1): a two-dot `base HEAD` diff also
		// includes the REVERSED diff of commits main gained after this branch
		// diverged, so an unrelated PR gets blamed for main-side files — a
		// false-positive block on ordinary base drift. Diffing from the
		// merge-base restricts the comparison to this branch's own changes.
		const mergeBase = runGit(['merge-base', baseBranch, 'HEAD'], cwd);
		const baseRef = mergeBase.exitCode === 0 ? mergeBase.stdout.trim() : null;
		if (!baseRef) {
			console.error(
				`[check-pending-fragment] could not resolve merge-base with ${baseBranch} — gate inconclusive, passing (fix your git setup if this persists)`,
			);
			return 0;
		}
		const changed = runGit(
				['diff', '--name-only', '--no-renames', '-z', baseRef, 'HEAD'],
				cwd,
			);
		if (changed.exitCode !== 0) {
			console.error(
				`[check-pending-fragment] git diff failed (exit ${changed.exitCode}) — gate inconclusive, passing rather than blocking on a git infrastructure failure`,
			);
			return 0;
		}
		changedFiles = splitNulList(changed.stdout);
		const added = runGit(
			['diff', '--diff-filter=A', '--name-only', '-z', '--find-renames=100%', baseRef, 'HEAD'],
			cwd,
		);
		if (added.exitCode !== 0) {
			console.error(
				`[check-pending-fragment] git diff --diff-filter=A failed (exit ${added.exitCode}) — treating added-files as unknown`,
			);
		} else {
			addedFiles = splitNulList(added.stdout);
		}
	} else {
		// No base branch (shallow checkout / detached context): the gate
		// cannot see a diff, so it reports inconclusive and passes. CI always
		// provides origin/main (full checkout); local runs on an up-to-date
		// main resolve a merge-base equal to HEAD and see an empty diff.
		console.log('[check-pending-fragment] no base branch found — nothing to compare, passing');
		return 0;
	}

	const result = evaluateFragmentCheck({ changedFiles, addedFiles });

	if (!result.violation) {
		console.log(`[check-pending-fragment] OK — ${result.message}`);
		return 0;
	}
	console.error(`[check-pending-fragment] VIOLATION — ${result.message}`);
	if (!resolveEnforce(process.env.FRAGMENT_CHECK_ENFORCE)) {
		console.error('[check-pending-fragment] FRAGMENT_CHECK_ENFORCE=0 — soft-warn only');
		return 0;
	}
	return 1;
}

function parsePrintRequirementArgs(
	args: readonly string[],
): {
	added: string[];
	addedFile: string | null;
	changedFile: string | null;
	format: PathListFormat | null;
} | { error: string } {
	const added: string[] = [];
	let addedFile: string | null = null;
	let changedFile: string | null = null;
	let format: PathListFormat | null = null;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--added') {
			if (i + 1 >= args.length) {
				return { error: '--added requires a value' };
			}
			added.push(args[i + 1]);
			i++;
		} else if (args[i] === '--added-file') {
			if (i + 1 >= args.length) {
				return { error: '--added-file requires a value' };
			}
			if (addedFile !== null) {
				return { error: '--added-file may be given only once' };
			}
			addedFile = args[i + 1];
			i++;
		} else if (args[i] === '--changed-file') {
			if (i + 1 >= args.length) {
				return { error: '--changed-file requires a value' };
			}
			if (changedFile !== null) {
				return { error: '--changed-file may be given only once' };
			}
			changedFile = args[i + 1];
			i++;
		} else if (args[i] === '--paths-format') {
			if (i + 1 >= args.length) {
				return { error: '--paths-format requires a value' };
			}
			const value = args[i + 1];
			if (value !== 'newline' && value !== 'nul' && value !== 'jsonl') {
				return { error: '--paths-format must be one of: newline, nul, jsonl' };
			}
			format = value;
			i++;
		} else {
			return { error: `unknown argument: ${args[i]}` };
		}
	}
	if (addedFile !== null && added.length > 0) {
		return {
			error:
				'--added and --added-file are mutually exclusive (both name the ADDED list)',
		};
	}
	return { added, addedFile, changedFile, format };
}

/** Input framing for --print-requirement list transport (issue #3290). */
export type PathListFormat = 'newline' | 'nul' | 'jsonl';

export const MAX_LIST_BYTES = 4 * 1024 * 1024;

/** Error carrying the decoder context; printRequirement maps it to exit 2. */
export class PathListDecodeError extends Error {
	constructor(
		message: string,
		public readonly source: string,
	) {
		super(message);
		this.name = 'PathListDecodeError';
	}
}

/**
 * Decode one transported path list. `newline` is the legacy mode (split on
 * newlines, tolerate CRLF); `nul` splits on NUL exactly like the quality
 * gate's internal `git diff -z` reads; `jsonl` parses one JSON-encoded path
 * string per line — the only framing that can carry quote, backslash,
 * control, and newline characters losslessly from `jq -c` output.
 */
export function decodePathList(
	raw: string,
	format: PathListFormat,
	source: string,
): string[] {
	if (format === 'nul') {
		return raw.split('\0').filter((entry) => entry.length > 0);
	}
	if (format === 'jsonl') {
		const out: string[] = [];
		const lines = raw.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].replace(/\r$/, '');
			if (line.length === 0) continue;
			try {
				const value: unknown = JSON.parse(line);
				if (typeof value !== 'string') {
					throw new Error('not a string');
				}
				out.push(value);
			} catch {
				throw new PathListDecodeError(
					`jsonl input is not a JSON-encoded path string at ${source} line ${i + 1}`,
					source,
				);
			}
		}
		return out;
	}
	return raw
		.split('\n')
		.map((line) => line.replace(/\r$/, ''))
		.filter((line) => line.length > 0);
}

function readBoundedFileSync(file: string, source: string): string {
	let stat: import('node:fs').Stats;
	try {
		stat = fs.statSync(file);
	} catch {
		throw new PathListDecodeError(`cannot read ${source}: ${file}`, source);
	}
	if (!stat.isFile()) {
		throw new PathListDecodeError(`${source} is not a regular file: ${file}`, source);
	}
	if (stat.size > MAX_LIST_BYTES) {
		throw new PathListDecodeError(
			`${source} exceeds the ${MAX_LIST_BYTES}-byte read bound (${stat.size} bytes): ${file}`,
			source,
		);
	}
	return fs.readFileSync(file, 'utf8');
}

async function readStdinBounded(source: string): Promise<string> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of Bun.stdin.stream() as AsyncIterable<Uint8Array>) {
		total += chunk.byteLength;
		if (total > MAX_LIST_BYTES) {
			throw new PathListDecodeError(
				`${source} exceeds the ${MAX_LIST_BYTES}-byte read bound (${total}+ bytes read)`,
				source,
			);
		}
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString('utf8');
}

/**
 * Machine-readable mode for workflow consumers (issue #2955; transport modes
 * and byte bounds from issue #3290): reads the changed-path list from stdin
 * (newline-delimited) or `--changed-file` in the `--paths-format` framing,
 * the added list from repeated `--added` flags or `--added-file` in the same
 * framing, prints exactly one verdict line, and maps the exit code to gate
 * semantics. Pure: no git, no repo-root resolution; the
 * FRAGMENT_CHECK_ENFORCE escape hatch does not apply (the caller owns its
 * messaging).
 */
export async function printRequirement(
	args: readonly string[],
	stdinText?: string,
): Promise<number> {
	const parsed = parsePrintRequirementArgs(args);
	if ('error' in parsed) {
		console.error(
			`[check-pending-fragment] ${parsed.error} (usage: --print-requirement [--paths-format newline|nul|jsonl] [--changed-file <path> | changed paths on stdin] [--added <path>]... | [--added-file <path>])`,
		);
		return 2;
	}
	const format: PathListFormat = parsed.format ?? 'newline';
	try {
		const changedRaw =
			parsed.changedFile !== null
				? readBoundedFileSync(parsed.changedFile, '--changed-file input')
				: stdinText !== undefined
					? stdinText
					: await readStdinBounded('stdin input');
		const addedRaw =
			parsed.addedFile !== null
				? readBoundedFileSync(parsed.addedFile, '--added-file input')
				: null;
		const changed = decodePathList(changedRaw, format, 'changed list');
		const added =
			addedRaw !== null
				? decodePathList(addedRaw, format, 'added list')
				: parsed.added;
		const verdict = evaluateRequirement(changed, added);
		console.log(`required=${verdict.required} satisfied=${verdict.satisfied}`);
		return verdict.violation ? 1 : 0;
	} catch (error) {
		if (error instanceof PathListDecodeError) {
			console.error(`[check-pending-fragment] ${error.message}`);
			return 2;
		}
		throw error;
	}
}

// Direct invocation entry point (mirrors check-test-file-cap.ts).
if (import.meta.main) {
	const args = process.argv.slice(2);
	if (args[0] === '--print-requirement') {
		process.exitCode = await printRequirement(args.slice(1));
	} else {
		process.exitCode = main();
	}
}

