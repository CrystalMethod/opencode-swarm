/**
 * Handle /swarm issue command.
 *
 * Triggers the architect to enter MODE: ISSUE_INGEST — the swarm issue ingest workflow.
 * Accepts issue URL in multiple formats and sanitizes inputs against injection.
 *
 * Flag parsing:
 *   --plan        → appends plan=true to emitted signal
 *   --trace       → appends trace=true to emitted signal (implies --plan)
 *   --no-repro    → appends noRepro=true to emitted signal
 *   no args       → returns usage string (no throw)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	buildIssueUrl,
	type ForgeContext,
	matchForgeResourceUrl,
	parseForgeRemoteUrl,
} from '../providers/forge-provider.js';
import { atomicWriteSwarmFileSync } from '../utils/atomic-write';
import { assertProjectRoot } from '../utils/project-boundary.js';

import {
	containsControlCharacters,
	detectGitRemote,
	parseGitRemoteUrl,
	sanitizeErrorEcho,
	sanitizeUrl,
	validateAndSanitizeGithubUrl,
} from './_shared/url-security.js';

const GITHUB_CONTEXT: ForgeContext = {
	provider: 'github',
	host: 'github.com',
};

const USAGE = [
	'Usage: /swarm issue <url|owner/repo#N|N> [--plan] [--trace] [--no-repro]',
	'',
	'Ingest a GitHub issue into the swarm workflow.',
	'  /swarm issue https://github.com/owner/repo/issues/42',
	'  /swarm issue owner/repo#42',
	'  /swarm issue 42 --plan',
	'  /swarm issue 42 --trace --no-repro',
	'',
	'Flags:',
	'  --plan        Transition to plan creation after spec generation',
	'  --trace       Run the fix workflow end-to-end (implies --plan); compose commit-pr to publish.',
	'  --no-repro    Skip reproduction step',
].join('\n');

function validateAndSanitizeUrl(rawUrl: string) {
	return validateAndSanitizeGithubUrl(rawUrl, 'issues');
}

interface ParsedArgs {
	plan: boolean;
	trace: boolean;
	noRepro: boolean;
	rest: string[];
}

function parseArgs(args: string[]): ParsedArgs {
	const out: ParsedArgs = {
		plan: false,
		trace: false,
		noRepro: false,
		rest: [],
	};
	for (const token of args) {
		if (token === '--plan') {
			out.plan = true;
			continue;
		}
		if (token === '--trace') {
			out.trace = true;
			out.plan = true; // --trace implies --plan
			continue;
		}
		if (token === '--no-repro') {
			out.noRepro = true;
			continue;
		}
		out.rest.push(token);
	}
	return out;
}

interface ParsedIssue {
	owner: string;
	repo: string;
	number: number;
	/** Provider context for canonical URL construction (issue #2733). */
	forge: ForgeContext;
}

/**
 * Parse issue reference from three formats:
 * 1. Full URL: https://github.com/owner/repo/issues/N or
 *    https://<gitlab-host>/owner/repo/-/issues/N (GitLab; owner may be a
 *    nested namespace path)
 * 2. Shorthand: owner/repo#N
 * 3. Bare number: N (requires git remote; provider-aware when the remote is
 *    GitLab-indicating)
 */
function parseIssueRef(input: string, directory: string): ParsedIssue | null {
	// Format 1: Full URL — GitHub shape first (unchanged), then GitLab.
	const urlMatch = input.match(
		/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/i,
	);
	if (urlMatch) {
		if (
			containsControlCharacters(urlMatch[1]) ||
			containsControlCharacters(urlMatch[2])
		) {
			return null;
		}
		return {
			owner: urlMatch[1],
			repo: urlMatch[2],
			number: parseInt(urlMatch[3], 10),
			forge: GITHUB_CONTEXT,
		};
	}

	if (/^https:\/\//i.test(input)) {
		const forge = matchForgeResourceUrl(input, 'issues');
		if (forge && forge.provider === 'gitlab') {
			return {
				owner: forge.owner,
				repo: forge.repo,
				number: forge.number,
				forge: { provider: forge.provider, host: forge.host },
			};
		}
		return null;
	}

	// Format 2: Shorthand owner/repo#N
	const shorthandMatch = input.match(/^([^/]+)\/([^#]+)#(\d+)$/);
	if (shorthandMatch) {
		if (
			containsControlCharacters(shorthandMatch[1]) ||
			containsControlCharacters(shorthandMatch[2])
		) {
			return null;
		}
		return {
			owner: shorthandMatch[1],
			repo: shorthandMatch[2],
			number: parseInt(shorthandMatch[3], 10),
			forge: GITHUB_CONTEXT,
		};
	}

	// Format 3: Bare number - needs git remote detection
	const bareMatch = input.match(/^(\d+)$/);
	if (bareMatch) {
		const issueNumber = parseInt(bareMatch[1], 10);
		const remoteUrl = detectGitRemote(directory, undefined);
		if (!remoteUrl) {
			return null;
		}

		// Host-aware first (GitLab remote → GitLab context + nested
		// namespace), then the legacy any-host fallback for GHE/proxy.
		const forgeRemote = parseForgeRemoteUrl(remoteUrl);
		if (forgeRemote) {
			return {
				owner: forgeRemote.owner,
				repo: forgeRemote.repo,
				number: issueNumber,
				forge: { provider: forgeRemote.provider, host: forgeRemote.host },
			};
		}

		const parsed = parseGitRemoteUrl(remoteUrl);
		if (!parsed) {
			return null;
		}

		return {
			owner: parsed.owner,
			repo: parsed.repo,
			number: issueNumber,
			forge: GITHUB_CONTEXT,
		};
	}

	return null;
}

/**
 * DI seam for filesystem operations — allows tests to override synchronous fs calls.
 */
export const _internals = {
	writeFileSync: fs.writeFileSync,
	mkdirSync: fs.mkdirSync,
	renameSync: fs.renameSync,
	unlinkSync: fs.unlinkSync,
	readFileSync: fs.readFileSync,
	existsSync: fs.existsSync,
};

/**
 * Atomic synchronous write, delegated to the canonical helper (issue #2035):
 * `.swarm` containment, registered `canonical-v1` temp grammar, fsync,
 * bounded rename retry, and exact own-temp cleanup in `finally`. The old
 * `.tmp-<filename>-<ts>-<pid>` grammar stays registered for residue
 * discovery; failure-injection tests target `src/utils/atomic-write.ts:
 * _internals` (renameSync/unlinkSync) — the seam moved there with the
 * implementation.
 */
function atomicWriteFileSync(
	dir: string,
	filename: string,
	content: string,
): void {
	atomicWriteSwarmFileSync(path.join(dir, filename), content);
}

export function handleIssueCommand(directory: string, args: string[]): string {
	const parsed = parseArgs(args);
	const rawInput = parsed.rest.join(' ').trim();

	// No args → return usage
	if (!rawInput) {
		return USAGE;
	}

	// Parse issue reference from input (sanitize first to strip query/fragment from full URLs)
	const isFullUrl = /^https?:\/\//i.test(rawInput);
	const issueInfo = parseIssueRef(
		isFullUrl ? sanitizeUrl(rawInput) : rawInput,
		directory,
	);
	if (!issueInfo) {
		return `Error: Could not parse issue reference from "${sanitizeErrorEcho(rawInput)}"\n\n${USAGE}`;
	}

	// Build the canonical issue URL for the resolved provider (GitHub output
	// unchanged; GitLab uses the /-/issues/N shape with the matched host).
	const issueUrl = buildIssueUrl(
		issueInfo.forge,
		issueInfo.owner,
		issueInfo.repo,
		issueInfo.number,
	);

	// Validate and sanitize URL
	const result = validateAndSanitizeUrl(issueUrl);
	if ('error' in result) {
		return `Error: ${result.error}\n\n${USAGE}`;
	}

	// Durable persistence: write issue reference and trace state before emitting signal
	try {
		assertProjectRoot(directory);
	} catch (error) {
		return `Error: Failed to persist issue reference durably: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`;
	}
	const swarmDir = path.join(directory, '.swarm');

	const issueReference: Record<string, unknown> = {
		url: result.sanitized,
		owner: issueInfo.owner,
		repo: issueInfo.repo,
		number: issueInfo.number,
		timestamp: new Date().toISOString(),
		flags: {
			...(parsed.plan && { plan: true }),
			...(parsed.trace && { trace: true }),
			...(parsed.noRepro && { noRepro: true }),
		},
	};
	if (parsed.noRepro) {
		issueReference.noReproWaiver = {
			waived: true,
			reason: '--no-repro flag',
			timestamp: new Date().toISOString(),
		};
	}

	// Issue #2600 (DD-C005): trace state describes a workflow the engine only
	// drives when --trace was passed (the hook returns early for non-trace
	// references). A non-trace invocation persists ONLY the issue reference and
	// leaves any pre-existing trace-state untouched — no misleading
	// `in_progress` record for a workflow that cannot run.
	const traceState = parsed.trace
		? {
				issueNumber: issueInfo.number,
				lastTransition: null as string | null,
				status: 'in_progress' as const,
			}
		: null;

	// Transactional write with rollback. Trace invocations write both artifacts
	// (state first, reference second; state rolls back to its prior content on
	// failure). Non-trace invocations write the reference only.
	let oldTraceState: string | null = null;
	if (traceState) {
		try {
			oldTraceState = _internals.readFileSync(
				path.join(swarmDir, 'issue-trace-state.json'),
				'utf-8',
			);
		} catch {
			/* absent — first time */
		}
	}

	try {
		_internals.mkdirSync(swarmDir, { recursive: true }); // drift-test:exempt — .swarm/ root bootstrap for issue persistence
		if (traceState) {
			atomicWriteFileSync(
				swarmDir,
				'issue-trace-state.json',
				JSON.stringify(traceState, null, 2),
			);
		}
		atomicWriteFileSync(
			swarmDir,
			'issue-reference.json',
			JSON.stringify(issueReference, null, 2),
		);
	} catch (e) {
		// Rollback trace-state to previous state (trace invocations only —
		// non-trace invocations never wrote it)
		if (traceState) {
			if (oldTraceState !== null) {
				try {
					atomicWriteFileSync(
						swarmDir,
						'issue-trace-state.json',
						oldTraceState,
					);
				} catch {
					/* restore failed */
				}
			} else {
				try {
					_internals.unlinkSync(path.join(swarmDir, 'issue-trace-state.json'));
				} catch {
					/* unlink failed */
				}
			}
		}
		// Clean up any partially-written issue-reference.json
		try {
			_internals.unlinkSync(path.join(swarmDir, 'issue-reference.json'));
		} catch {
			/* may not exist */
		}
		const errMsg = e instanceof Error ? e.message : String(e);
		return `Error: Failed to persist issue reference durably: ${errMsg}\n\n${USAGE}`;
	}

	// Build flags string
	const flags: string[] = [];
	if (parsed.plan) flags.push('plan=true');
	if (parsed.trace) flags.push('trace=true');
	if (parsed.noRepro) flags.push('noRepro=true');
	const flagsStr = flags.length > 0 ? ` ${flags.join(' ')}` : '';

	return `[MODE: ISSUE_INGEST issue="${result.sanitized}"${flagsStr}]`;
}
