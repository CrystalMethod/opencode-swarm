/**
 * Shared forge PR-reference parsing and sanitization for the
 * `/swarm pr-review` and `/swarm pr-feedback` commands.
 *
 * Both commands accept a PR/MR reference in three formats (full URL,
 * `owner/repo#N`, or a bare PR number resolved against the `origin` remote)
 * and may be followed by free-text instructions that are forwarded to the
 * architect in the emitted `[MODE: ...]` signal. All parsing here is hardened
 * against prompt injection: rival `[MODE: ...]` headers, query strings,
 * fragments, and embedded credentials are stripped before the value is ever
 * placed back into a signal string.
 *
 * Provider-aware since issue #2733: GitLab merge-request URLs
 * (`https://<gitlab-host>/owner/repo/-/merge_requests/N`, owner may be a
 * nested namespace path) resolve through the same three formats, and the
 * canonical URL is rebuilt with the matched provider's shape via
 * `src/providers/forge-provider.ts`. GitHub behavior is byte-identical to the
 * pre-provider implementation, including the any-host path fallback used for
 * GHE/proxy bare-number resolution.
 */

import { loadPluginConfig } from '../config/loader.js';
import {
	buildPrUrl,
	detectForgeFromUrl,
	type ForgeContext,
	matchForgeResourceUrl,
	parseForgeRemoteUrl,
	resolveForgeContextFromPluginConfig,
} from '../providers/forge-provider.js';
import {
	_internals,
	containsControlCharacters,
	detectGitRemote,
	parseGitRemoteUrl,
	sanitizeErrorEcho,
	sanitizeUrl,
	type ValidationResult,
	validateAndSanitizeGithubUrl,
} from './_shared/url-security.js';

export { _internals, detectGitRemote, parseGitRemoteUrl, sanitizeUrl };
export type { ValidationResult };

/** Upper bound on forwarded free-text instructions (post-sanitization). */
const MAX_INSTRUCTIONS_LEN = 1000;

const GITHUB_CONTEXT: ForgeContext = {
	provider: 'github',
	host: 'github.com',
};

/**
 * Sanitize free-text instructions so they cannot forge a competing MODE
 * header, inject control sequences, or break out of the signal line.
 * Collapses whitespace (including newlines), strips bracketed `[MODE: ...]`
 * headers, and truncates to a bounded length.
 */
export function sanitizeInstructions(raw: string): string {
	const collapsed = raw.replace(/\s+/g, ' ').trim();
	const stripped = collapsed.replace(/\[\s*MODE\s*:[^\]]*\]/gi, '');
	let normalized = stripped.replace(/\s+/g, ' ').trim();
	// Control characters never belong in a MODE signal line (H4): strip any
	// C0/DEL the whitespace collapse did not remove.
	if (containsControlCharacters(normalized)) {
		normalized = normalized.replace(/[\u0000-\u001f\u007f]/gu, '');
	}
	if (normalized.length <= MAX_INSTRUCTIONS_LEN) return normalized;
	return `${normalized.slice(0, MAX_INSTRUCTIONS_LEN)}…`;
}

export function validateAndSanitizeUrl(
	rawUrl: string,
	configured?: ForgeContext,
): ValidationResult {
	return validateAndSanitizeGithubUrl(rawUrl, 'pull', configured);
}

export interface ParsedPr {
	owner: string;
	repo: string;
	number: number;
}

/** Parsed PR plus the provider context the reference resolved to. */
export interface ResolvedPrRef extends ParsedPr {
	context: ForgeContext;
}

/**
 * Lazily resolve the CONFIGURED forge context (plugin config `forge` section +
 * origin remote). Only consulted when config-free shape detection cannot
 * answer (generic-host full URLs, or bare numbers whose remote host is not
 * forge-indicating) — ordinary GitHub usage never loads config here, so
 * GitHub behavior and latency are unchanged (issue #2733 final-critic fix).
 */
function loadConfiguredForgeContext(
	directory?: string,
): ForgeContext | undefined {
	try {
		const config = loadPluginConfig(directory ?? process.cwd());
		const remote = detectGitRemote(directory, undefined);
		const remotes = remote ? [remote] : [];
		return resolveForgeContextFromPluginConfig(config, remotes) ?? undefined;
	} catch {
		return undefined;
	}
}

function bareNumberContext(
	cwd?: string,
): { ctx: ForgeContext; owner: string; repo: string } | null {
	const remoteUrl = detectGitRemote(cwd, undefined);
	if (!remoteUrl) {
		return null;
	}

	// Host-aware first: a GitLab remote yields a GitLab context with the
	// instance host preserved (and nested namespaces kept intact).
	const forge = parseForgeRemoteUrl(remoteUrl);
	if (forge) {
		return { ctx: forge, owner: forge.owner, repo: forge.repo };
	}

	// Configured-context fallback (issue #2733): a generic-host remote on a
	// project whose `forge` config declares a GitLab instance resolves in
	// that context (host preserved for canonical MR URLs).
	const configured = loadConfiguredForgeContext(cwd);
	if (configured?.provider === 'gitlab') {
		const generic = remoteUrl.match(/^https:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/i);
		if (generic && generic[1].toLowerCase() === configured.host) {
			const segments = generic[2]
				.split('/')
				.filter((x) => x.length > 0 && x !== '.git');
			if (segments.length >= 2) {
				const repo = segments[segments.length - 1];
				const owner = segments.slice(0, -1).join('/');
				return { ctx: configured, owner, repo };
			}
		}
	}

	// Legacy fallback (unchanged): GitHub-shaped remotes and GHE/proxy hosts
	// resolve owner/repo through the any-host path form and keep the GitHub
	// canonical URL shape.
	const parsed = parseGitRemoteUrl(remoteUrl);
	if (!parsed) {
		return null;
	}
	return { ctx: GITHUB_CONTEXT, owner: parsed.owner, repo: parsed.repo };
}

/**
 * Resolve a PR/MR reference from three formats, preserving the provider
 * context needed to rebuild the canonical URL:
 * 1. Full URL: https://github.com/owner/repo/pull/N or
 *    https://<gitlab-host>/owner/repo/-/merge_requests/N
 * 2. Shorthand: owner/repo#N (GitHub-shaped; namespace shorthands are
 *    ambiguous without a configured provider, so they stay GitHub)
 * 3. Bare number: N (resolved against the `origin` git remote in `cwd`,
 *    provider-aware when the remote is GitLab-indicating)
 */
export function resolvePrRef(
	input: string,
	cwd?: string,
): ResolvedPrRef | null {
	// Format 1: Full URL — GitHub shape first (unchanged semantics), then the
	// forge matcher for GitLab MR shapes.
	const urlMatch = input.match(
		/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/i,
	);
	if (urlMatch) {
		if (
			containsControlCharacters(urlMatch[1]) ||
			containsControlCharacters(urlMatch[2])
		) {
			return null;
		}
		return {
			context: GITHUB_CONTEXT,
			owner: urlMatch[1],
			repo: urlMatch[2],
			number: parseInt(urlMatch[3], 10),
		};
	}

	if (/^https:\/\//i.test(input)) {
		const forge = matchForgeResourceUrl(
			input,
			'pull',
			detectForgeFromUrl(input) ? undefined : loadConfiguredForgeContext(cwd),
		);
		if (forge && forge.provider === 'gitlab') {
			return {
				context: { provider: forge.provider, host: forge.host },
				owner: forge.owner,
				repo: forge.repo,
				number: forge.number,
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
			context: GITHUB_CONTEXT,
			owner: shorthandMatch[1],
			repo: shorthandMatch[2],
			number: parseInt(shorthandMatch[3], 10),
		};
	}

	// Format 3: Bare number - needs git remote detection
	const bareMatch = input.match(/^(\d+)$/);
	if (bareMatch) {
		const prNumber = parseInt(bareMatch[1], 10);
		const remote = bareNumberContext(cwd);
		if (!remote) {
			return null;
		}
		return {
			context: remote.ctx,
			owner: remote.owner,
			repo: remote.repo,
			number: prNumber,
		};
	}

	return null;
}

/**
 * Parse a PR reference from three formats (see `resolvePrRef`). Public API
 * unchanged since the pre-provider implementation: returns owner/repo/number
 * only — the GitLab owner may be a multi-segment namespace path.
 */
export function parsePrRef(input: string, cwd?: string): ParsedPr | null {
	const resolved = resolvePrRef(input, cwd);
	if (!resolved) return null;
	return {
		owner: resolved.owner,
		repo: resolved.repo,
		number: resolved.number,
	};
}

/**
 * Whether a token is *shaped* like a PR reference — a full `http(s)` URL, an
 * `owner/repo#N` shorthand, or a bare number. This is intent detection, not
 * validation: a token can look like a PR ref yet still fail to resolve (e.g. a
 * bare number when no `origin` remote exists, or a non-GitHub URL). Callers that
 * accept free-text fallbacks (pr-feedback) use this to tell "the user meant a PR
 * reference but it didn't resolve" (surface an error) from "the user typed
 * instructions" (forward them).
 */
export function looksLikePrRef(token: string): boolean {
	return (
		/^https?:\/\//i.test(token) ||
		/^[^/]+\/[^#]+#\d+$/.test(token) ||
		/^\d+$/.test(token)
	);
}

/**
 * Resolve a PR reference to its canonical URL plus parsed fields — the
 * provider-aware construction shared by subscribe/unsubscribe and the review
 * commands. GitHub output is byte-identical to the previous hardcoded
 * `https://github.com/...` template.
 */
export function resolveCanonicalPrUrl(
	input: string,
	cwd?: string,
): { prUrl: string; owner: string; repo: string; number: number } | null {
	const resolved = resolvePrRef(input, cwd);
	if (!resolved) return null;
	return {
		prUrl: buildPrUrl(
			resolved.context,
			resolved.owner,
			resolved.repo,
			resolved.number,
		),
		owner: resolved.owner,
		repo: resolved.repo,
		number: resolved.number,
	};
}

/**
 * Resolve the leading token of a PR command's positional args into a validated
 * forge PR URL, and collect any trailing tokens as free-text instructions.
 *
 * `rest` is the positional token list AFTER flag parsing (e.g. `--council`
 * already removed). The first token is the PR reference; everything after it
 * is sanitized and returned as `instructions` for forwarding in the MODE
 * signal. `cwd` is the project directory used to resolve a bare PR number
 * against the `origin` remote.
 *
 * Returns `null` when there are no positional tokens (caller shows usage).
 */
export type PrCommandInput =
	| { prUrl: string; instructions: string }
	| { error: string };

export function resolvePrCommandInput(
	rest: string[],
	cwd?: string,
): PrCommandInput | null {
	if (rest.length === 0) {
		// No args at all — caller should show usage.
		return null;
	}

	const refToken = rest[0];
	const instructions = sanitizeInstructions(rest.slice(1).join(' '));

	// Parse PR reference (sanitize full URLs first to strip query/fragment).
	const isFullUrl = /^https?:\/\//i.test(refToken);
	const resolved = resolvePrRef(
		isFullUrl ? sanitizeUrl(refToken) : refToken,
		cwd,
	);
	if (!resolved) {
		return {
			error: `Could not parse PR reference from "${sanitizeErrorEcho(refToken)}"`,
		};
	}

	const prUrl = buildPrUrl(
		resolved.context,
		resolved.owner,
		resolved.repo,
		resolved.number,
	);
	// A configured generic GitLab host must be authorized at validation too
	// (shape detection alone would reject it); the derived context IS the
	// declaration, so passing it is authorization by configuration, not a
	// whitelist bypass — every guard still applies.
	const urlContext =
		resolved.context.provider === 'gitlab' &&
		!resolved.context.host.startsWith('gitlab.')
			? resolved.context
			: undefined;
	const result = validateAndSanitizeGithubUrl(prUrl, 'pull', urlContext);
	if ('error' in result) {
		return { error: result.error };
	}

	return { prUrl: result.sanitized, instructions };
}
