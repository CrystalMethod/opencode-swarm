import * as child_process from 'node:child_process';
import {
	type ForgeContext,
	matchForgeResourceUrl,
} from '../../providers/forge-provider.js';
import {
	containsControlCharacters,
	hasNonAsciiHostname,
	isIPv4ZeroNetwork,
	isIpv4MappedPrivateHost,
	isPrivateHost,
} from '../../providers/host-guards.js';
import { mergeEnvForChild } from '../../utils/bun-compat';
import { resolveGitExecutable } from '../../utils/git-executable.js';

// Host/URL-component guards live in src/providers/host-guards.ts since issue
// #2733 (shared with the forge provider layer without a circular import);
// re-exported here so this module's public API is unchanged.
export {
	containsControlCharacters,
	isIPv4ZeroNetwork,
	isIpv4MappedPrivateHost,
	isPrivateHost,
};

export const MAX_URL_LEN = 2048;

export type ValidationResult = { sanitized: string } | { error: string };

/**
 * File-scoped indirection seam for git remote lookups.
 * Supports envOverrides so lane runtime profiles can inject env.
 */
export const _internals = {
	spawnSync: (
		cmd: string,
		args: string[],
		options?: {
			cwd?: string;
			encoding?: BufferEncoding;
			timeout?: number;
			env?: Record<string, string | undefined>;
			envOverrides?: Record<string, string | null>;
			stdio?:
				| 'pipe'
				| 'ignore'
				| 'inherit'
				| Array<'pipe' | 'ignore' | 'inherit'>;
		},
	) => {
		const mergedEnv = mergeEnvForChild(options?.env, options?.envOverrides);
		return child_process.spawnSync(cmd, args, {
			...options,
			env: mergedEnv as NodeJS.ProcessEnv | undefined,
		});
	},
};

/**
 * Strip query strings, fragments, injected MODE headers, and credentials from
 * a URL string.
 */
export function sanitizeUrl(raw: string): string {
	let urlStr = raw.trim();

	urlStr = urlStr.replace(/\[\s*MODE\s*:[^\]]*\]/gi, '');

	const fragmentIdx = urlStr.indexOf('#');
	if (fragmentIdx !== -1) {
		urlStr = urlStr.slice(0, fragmentIdx);
	}

	const queryIdx = urlStr.indexOf('?');
	if (queryIdx !== -1) {
		urlStr = urlStr.slice(0, queryIdx);
	}

	urlStr = urlStr.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^@/]+@/, 'https://');

	if (urlStr.length > MAX_URL_LEN) {
		urlStr = urlStr.slice(0, MAX_URL_LEN);
	}

	return urlStr.trim();
}

/**
 * Strip control characters from user-visible error echoes and bound the result.
 */
export function sanitizeErrorEcho(raw: string, maxLength: number = 80): string {
	let stripped = '';
	for (const ch of raw) {
		const cp = ch.codePointAt(0);
		if (cp !== undefined && (cp <= 0x1f || cp === 0x7f)) {
			stripped += ' ';
			continue;
		}
		stripped += ch;
	}
	const collapsed = stripped.replace(/\s+/g, ' ').trim();
	if (collapsed.length <= maxLength) return collapsed;
	return `${collapsed.slice(0, maxLength)}…`;
}

/**
 * Validate and sanitize a forge resource URL for a specific resource kind.
 *
 * Provider-aware since issue #2733: accepts GitHub issue/PR URLs
 * (`https://github.com/owner/repo/issues|pull/N`) and GitLab issue/MR URLs
 * (`https://<gitlab-host>/owner/repo/-/issues|merge_requests/N`, where the
 * owner may be a nested namespace path and the host is gitlab.com or any
 * `gitlab.`-prefixed self-hosted instance). Every security control applies
 * identically to both providers and to every origin: HTTPS-only, IDN
 * (non-ASCII) host rejection, private/localhost host rejection, credential
 * stripping, bounded URL length, and control-character sanitization — the
 * shared guards in src/providers/host-guards.ts.
 */
export function validateAndSanitizeGithubUrl(
	rawUrl: string,
	resource: 'issues' | 'pull',
	configured?: ForgeContext,
): ValidationResult {
	const sanitized = sanitizeUrl(rawUrl);

	if (!sanitized) {
		return { error: 'Empty URL' };
	}

	if (!sanitized.startsWith('https://')) {
		return { error: 'URL must use HTTPS scheme' };
	}

	try {
		const url = new URL(sanitized);

		if (hasNonAsciiHostname(url.hostname)) {
			return { error: 'Non-ASCII hostnames are not allowed' };
		}

		if (isPrivateHost(url)) {
			return { error: 'Private or localhost URLs are not allowed' };
		}

		const matched = matchForgeResourceUrl(sanitized, resource, configured);
		if (!matched) {
			return {
				error:
					resource === 'issues'
						? 'URL must be a GitHub issue URL (https://github.com/owner/repo/issues/N) or a GitLab issue URL (https://<gitlab-host>/owner/repo/-/issues/N)'
						: 'URL must be a GitHub pull request URL (https://github.com/owner/repo/pull/N) or a GitLab merge request URL (https://<gitlab-host>/owner/repo/-/merge_requests/N)',
			};
		}

		return { sanitized };
	} catch {
		// Justification: URL constructor throws TypeError for malformed URLs.
		// This catch is part of the validation flow — converting the throw
		// into a structured { error } result keeps the API consistent.
		return { error: 'Invalid URL format' };
	}
}

/**
 * Detect the `origin` remote URL from git config.
 * @param cwd - Optional working directory
 * @param laneEnv - Optional lane env overrides for git spawn
 */
export function detectGitRemote(
	cwd?: string,
	laneEnv?: Record<string, string>,
): string | null {
	try {
		const result = _internals.spawnSync(
			resolveGitExecutable(),
			['remote', 'get-url', 'origin'],
			{
				encoding: 'utf-8',
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: 5000,
				...(cwd ? { cwd } : {}),
				envOverrides: laneEnv,
			},
		);

		if (result.status !== 0 || result.error) {
			return null;
		}

		const remoteUrl = ((result.stdout as string) ?? '').trim();

		return remoteUrl || null;
	} catch {
		// Justification: best-effort remote detection — git may not be
		// installed, the cwd may not be a git repo, or the spawn may fail
		// for any reason. Returning null signals "unknown" to the caller,
		// which is the safest fallback for URL validation.
		return null;
	}
}

/**
 * Parse owner/repo from a git remote URL.
 *
 * GitHub-specific HTTPS/SSH forms plus an any-host path fallback (the
 * fallback preserves the documented GHE/proxy bare-number resolution). For
 * host-aware parsing that preserves the instance host and GitLab nested
 * namespaces, use `parseForgeRemoteUrl` in src/providers/forge-provider.ts.
 */
export function parseGitRemoteUrl(
	remoteUrl: string,
): { owner: string; repo: string } | null {
	const httpsMatch = remoteUrl.match(
		/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
	);
	if (httpsMatch) {
		const owner = httpsMatch[1];
		const repo = httpsMatch[2].replace(/\.git$/, '');
		if (containsControlCharacters(owner) || containsControlCharacters(repo)) {
			return null;
		}
		return { owner, repo };
	}

	const sshMatch = remoteUrl.match(
		/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i,
	);
	if (sshMatch) {
		const owner = sshMatch[1];
		const repo = sshMatch[2].replace(/\.git$/, '');
		if (containsControlCharacters(owner) || containsControlCharacters(repo)) {
			return null;
		}
		return { owner, repo };
	}

	const pathMatch = remoteUrl.match(/\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
	if (pathMatch) {
		const owner = pathMatch[1];
		const repo = pathMatch[2].replace(/\.git$/, '');
		if (containsControlCharacters(owner) || containsControlCharacters(repo)) {
			return null;
		}
		return { owner, repo };
	}

	return null;
}
