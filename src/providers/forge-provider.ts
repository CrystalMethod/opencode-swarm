/**
 * Forge provider core (issue #2733): the provider model that makes GitLab a
 * first-class forge alongside GitHub for the PR/issue command surface.
 *
 * This module is the SINGLE source of truth for provider-specific facts that
 * were previously hardcoded inline at every integration point (see the trace
 * localization log for the six duplicated validators it replaces):
 *
 *   - which hosts indicate which provider (`detectForgeFromUrl`)
 *   - how a git remote maps to provider + host + owner/repo
 *     (`parseForgeRemoteUrl`; GitLab owners may be nested namespace paths)
 *   - how canonical PR/MR and issue URLs are built (`buildPrUrl`/`buildIssueUrl`)
 *   - how a PR URL canonicalizes for identity matching (`canonicalForgePrUrl`,
 *     a drop-in for the four module-local `canonicalGitHubPrUrl` copies)
 *   - how an explicit provider/base_url configuration plus the observed git
 *     remotes resolve to a provider context (`resolveProviderSelection`,
 *     fail-closed on ambiguity)
 *   - which GitHub-synthesized fields a provider can serve
 *     (`getProviderCapabilities` — honest "unavailable" reporting; GitLab's MR
 *     API does not synthesize statusCheckRollup/reviewDecision/mergeStateStatus)
 *
 * Shape detection is CONFIG-FREE for the well-known hosts: github.com →
 * github; gitlab.com and any host whose first label is `gitlab` → gitlab with
 * that host. Every other host is generic and requires an explicit configured
 * context (`resolveProviderSelection`); it is never silently assumed.
 *
 * Security note: every guard applied to GitHub URLs applies here unchanged —
 * HTTPS-only, private/localhost-host rejection, IDN (non-ASCII) host
 * rejection, control-character rejection — via the shared guards in
 * `./host-guards.ts` (the same implementation url-security.ts re-exports).
 * The `base_url` override is NOT a trust whitelist: it passes through the
 * same guards and never bypasses one.
 */

import {
	containsControlCharacters,
	hasNonAsciiHostname,
	hasPunycodeLabel,
	isPrivateHost,
} from './host-guards.js';

export type ForgeProviderId = 'github' | 'gitlab';

/** Canonical web host, lowercase (e.g. 'github.com', 'gitlab.internal.example.com'). */
export interface ForgeContext {
	provider: ForgeProviderId;
	host: string;
}

export interface ForgeRemote extends ForgeContext {
	owner: string;
	repo: string;
}

export interface ForgeResourceRef extends ForgeContext {
	owner: string;
	repo: string;
	number: number;
}

export interface ProviderSelectionInput {
	config?: {
		provider?: 'github' | 'gitlab' | 'auto';
		/** camelCase form (frozen-check binding). */
		baseUrl?: string;
		/** snake_case form — the plugin config schema key (`forge.base_url`). */
		base_url?: string;
	};
	remotes: string[];
}

export type ProviderSelection =
	| { ok: true; context: ForgeContext }
	| { ok: false; error: string };

/** Fields GitHub's `gh pr view` synthesizes and GitLab's MR API does not. */
export interface ForgeCapabilities {
	statusCheckRollup: boolean;
	reviewDecision: boolean;
	mergeStateStatus: boolean;
}

export const GITHUB_CANONICAL_HOST = 'github.com';
export const GITLAB_PUBLIC_HOST = 'gitlab.com';

/** Hosts whose first DNS label is exactly `gitlab` (gitlab.com, gitlab.example.com). */
export function isGitLabIndicatingHost(host: string): boolean {
	const lower = host.toLowerCase();
	return lower === GITLAB_PUBLIC_HOST || lower.startsWith('gitlab.');
}

/**
 * True when the URL string is a canonical PR URL of either provider shape.
 * A `configured` context (declared via `forge.base_url`) additionally
 * authorizes exactly that generic self-hosted GitLab host — every guard in
 * canonicalForgePrUrl still applies to the URL itself.
 */
export function isForgePrUrl(url: string, configured?: ForgeContext): boolean {
	return canonicalForgePrUrl(url, configured) !== null;
}

/**
 * Shape-based provider detection from any https URL. github.com → github;
 * gitlab.com or a `gitlab.`-prefixed host → gitlab with that host; anything
 * else → null unless the host matches a `configured` context (issue #2733:
 * `forge.base_url` declares a generic self-hosted GitLab instance, and the
 * declared host is then authorized exactly as gitlab.com is — it is NOT a
 * trust whitelist: every URL guard still applies).
 */
export function detectForgeFromUrl(
	url: string,
	configured?: ForgeContext,
): ForgeContext | null {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'https:') return null;
		const host = parsed.hostname.toLowerCase();
		if (hasNonAsciiHostname(host) || hasPunycodeLabel(host)) return null;
		// Defense in depth (review round 4): private/localhost hosts are
		// rejected even when a configured declaration names them, so a
		// tampered .swarm record cannot smuggle one past the read validators.
		if (isPrivateHost(parsed)) return null;
		if (host === GITHUB_CANONICAL_HOST) {
			return { provider: 'github', host };
		}
		if (isGitLabIndicatingHost(host)) {
			return { provider: 'gitlab', host };
		}
		if (
			configured &&
			configured.provider === 'gitlab' &&
			host === configured.host
		) {
			return { provider: 'gitlab', host };
		}
		return null;
	} catch {
		return null;
	}
}

function isConfiguredGitLabHost(
	host: string,
	configured?: ForgeContext,
): boolean {
	return (
		configured !== undefined &&
		configured.provider === 'gitlab' &&
		host === configured.host
	);
}

const GITLAB_PROJECT_PATH_PATTERN =
	/^\/(.+)\/([^/]+)\/-\/(merge_requests|issues)\/(\d+)\/?$/;

/**
 * Match a resource URL (`resource: 'pull'` matches GitHub `/pull/N` and GitLab
 * `/-/merge_requests/N`; `'issues'` matches `/issues/N` and `/-/issues/N`).
 * Returns the provider context plus owner/repo/number, or null when the URL
 * is not a well-formed resource URL of a recognized provider host. Owner may
 * be a multi-segment namespace path for GitLab. The input must already be
 * sanitized (query/fragment/credentials stripped) by the caller.
 */
export function matchForgeResourceUrl(
	url: string,
	resource: 'issues' | 'pull',
	configured?: ForgeContext,
): ForgeResourceRef | null {
	// Raw-string control-character guard: the WHATWG URL parser
	// percent-encodes C0 bytes in the pathname, so checking the parsed
	// captures alone would let an embedded control byte slip through
	// (C5-09). No legitimate forge resource URL contains one.
	if (containsControlCharacters(url)) return null;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== 'https:') return null;
	const host = parsed.hostname.toLowerCase();
	if (hasNonAsciiHostname(host)) return null;

	if (host === GITHUB_CANONICAL_HOST) {
		const m = parsed.pathname.match(
			new RegExp(
				`^\\/([^/]+)\\/([^/]+)\\/${resource === 'pull' ? 'pull' : 'issues'}\\/([0-9]+)\\/?$`,
			),
		);
		if (!m) return null;
		if (containsControlCharacters(m[1]) || containsControlCharacters(m[2])) {
			return null;
		}
		const number = Number.parseInt(m[3], 10);
		if (!Number.isSafeInteger(number) || number <= 0) return null;
		return { provider: 'github', host, owner: m[1], repo: m[2], number };
	}

	if (
		isGitLabIndicatingHost(host) ||
		isConfiguredGitLabHost(host, configured)
	) {
		const resourceSegment = resource === 'pull' ? 'merge_requests' : 'issues';
		const m = parsed.pathname.match(GITLAB_PROJECT_PATH_PATTERN);
		if (!m || m[3] !== resourceSegment) return null;
		if (containsControlCharacters(m[1]) || containsControlCharacters(m[2])) {
			return null;
		}
		const number = Number.parseInt(m[4], 10);
		if (!Number.isSafeInteger(number) || number <= 0) return null;
		return { provider: 'gitlab', host, owner: m[1], repo: m[2], number };
	}

	return null;
}

/**
 * Host-aware git-remote parsing (HTTPS and SSH scp forms). GitLab owners may
 * be nested namespace paths (`group/subgroup/repo` → owner `group/subgroup`);
 * the host is preserved and lowercased. Generic hosts return null — unlike
 * url-security's legacy `parseGitRemoteUrl` path fallback (kept for GHE/proxy
 * bare-number resolution), this function never guesses a provider.
 */
export function parseForgeRemoteUrl(remoteUrl: string): ForgeRemote | null {
	const https = remoteUrl.match(/^https:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/i);
	if (https) {
		return remotePathResult(https[1], https[2]);
	}
	const ssh = remoteUrl.match(/^git@([^:/]+):(.+?)(?:\.git)?$/i);
	if (ssh) {
		return remotePathResult(ssh[1], ssh[2]);
	}
	return null;
}

function remotePathResult(
	rawHost: string,
	projectPath: string,
): ForgeRemote | null {
	const host = rawHost.toLowerCase();
	if (!host || hasNonAsciiHostname(host) || hasPunycodeLabel(host)) return null;
	if (!isGitLabIndicatingHost(host) && host !== GITHUB_CANONICAL_HOST) {
		return null;
	}
	const segments = projectPath.split('/').filter((s) => s.length > 0);
	if (segments.length < 2) return null;
	const repo = segments[segments.length - 1];
	const owner = segments.slice(0, -1).join('/');
	if (!owner || !repo) return null;
	if (containsControlCharacters(owner) || containsControlCharacters(repo)) {
		return null;
	}
	return {
		provider: host === GITHUB_CANONICAL_HOST ? 'github' : 'gitlab',
		host,
		owner,
		repo,
	};
}

/** Build the canonical PR/MR URL for a provider context. */
export function buildPrUrl(
	ctx: ForgeContext,
	owner: string,
	repo: string,
	number: number,
): string {
	if (ctx.provider === 'gitlab') {
		return `https://${ctx.host}/${owner}/${repo}/-/merge_requests/${number}`;
	}
	return `https://github.com/${owner}/${repo}/pull/${number}`;
}

/** Build the canonical issue URL for a provider context. */
export function buildIssueUrl(
	ctx: ForgeContext,
	owner: string,
	repo: string,
	number: number,
): string {
	if (ctx.provider === 'gitlab') {
		return `https://${ctx.host}/${owner}/${repo}/-/issues/${number}`;
	}
	return `https://github.com/${owner}/${repo}/issues/${number}`;
}

/**
 * Canonical scheme-less lowercase PR/MR URL for identity matching — the
 * provider-aware replacement for the four duplicated `canonicalGitHubPrUrl`
 * implementations (github output is byte-identical: host and owner/repo
 * lowercased, trailing slash dropped). Null for anything that is not an
 * https PR/MR URL of a recognized provider host.
 */
export function canonicalForgePrUrl(
	value: string,
	configured?: ForgeContext,
): string | null {
	try {
		const url = new URL(value);
		if (url.protocol !== 'https:') return null;
		const host = url.hostname.toLowerCase();
		// Defense in depth (review rounds 4 + final-critic round 3): the
		// IDN/punycode and private-host guards apply to EVERY branch,
		// including the configured-host branch — a tampered durable record
		// declaring a punycode or private/localhost host never canonicalizes
		// (write-path guards already prevent legitimate declarations from ever
		// being such; this closes tampered reads and keeps this validator
		// consistent with detectForgeFromUrl).
		if (hasNonAsciiHostname(host) || hasPunycodeLabel(host)) return null;
		if (isPrivateHost(url)) return null;

		if (host === GITHUB_CANONICAL_HOST) {
			const m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
			if (!m) return null;
			const number = Number(m[3]);
			if (!Number.isSafeInteger(number) || number <= 0) return null;
			return `github.com/${m[1].toLowerCase()}/${m[2].toLowerCase()}/pull/${number}`;
		}

		if (
			isGitLabIndicatingHost(host) ||
			isConfiguredGitLabHost(host, configured)
		) {
			const m = url.pathname.match(
				/^\/(.+)\/([^/]+)\/-\/merge_requests\/(\d+)\/?$/,
			);
			if (!m) return null;
			const number = Number(m[3]);
			if (!Number.isSafeInteger(number) || number <= 0) return null;
			return `${host}/${m[1].toLowerCase()}/${m[2].toLowerCase()}/-/merge_requests/${number}`;
		}

		return null;
	} catch {
		return null;
	}
}

/**
 * Honest capability reporting. GitHub's `gh pr view` synthesizes these three
 * fields; GitLab's MR API does not provide equivalents, so consumers must
 * surface an explicit "not supported / unavailable" marker instead of
 * fabricating or substituting a value (issue #2733 AC7).
 */
export function getProviderCapabilities(
	provider: ForgeProviderId,
): ForgeCapabilities {
	if (provider === 'gitlab') {
		return {
			statusCheckRollup: false,
			reviewDecision: false,
			mergeStateStatus: false,
		};
	}
	return {
		statusCheckRollup: true,
		reviewDecision: true,
		mergeStateStatus: true,
	};
}

/**
 * Production adapter: resolve the active forge context from the plugin
 * config's `forge` section (schema keys: provider, base_url) plus the
 * observed git remotes. Returns null when no context can be determined —
 * callers fall back to config-free shape detection (GitHub behavior
 * unchanged). Used lazily by the command surface ONLY when shape detection
 * cannot answer (generic-host URLs / ambiguous bare numbers), so ordinary
 * GitHub usage performs zero extra I/O.
 */
export function resolveForgeContextFromPluginConfig(
	pluginConfig:
		| { forge?: { provider?: string; base_url?: string } }
		| undefined,
	remotes: string[],
): ForgeContext | null {
	if (!pluginConfig?.forge) return null;
	const forge = pluginConfig.forge;
	const provider =
		forge.provider === 'github' ||
		forge.provider === 'gitlab' ||
		forge.provider === 'auto'
			? forge.provider
			: undefined;
	const selection = resolveProviderSelection({
		config: { provider, baseUrl: forge.base_url },
		remotes,
	});
	return selection.ok ? selection.context : null;
}

function invalidBaseUrlError(reason: string): string {
	return `Invalid forge.base_url (${reason}) — provider config rejected; base_url must be an HTTPS URL on a public, ASCII host and is never a trust whitelist.`;
}

/**
 * Resolve the active provider context from explicit configuration plus the
 * observed git remotes. FAIL-CLOSED on ambiguity — a mixed/generic/empty
 * remote set never silently assumes a provider.
 *
 * Rules (frozen by acceptance checks C3/C4):
 *  1. A configured `baseUrl` runs through the same guards as any forge URL
 *     (HTTPS-only, non-private, ASCII host) and is stripped to its host; a
 *     failing baseUrl is a configuration error, not a fallback trigger.
 *  2. Explicit `provider: 'github'` selects github.com; combining it with a
 *     `baseUrl` is a configuration conflict (GitHub's base is fixed).
 *  3. Explicit `provider: 'gitlab'` takes its host from a valid `baseUrl`,
 *     else from a unanimously GitLab-indicating remote set — never assumes
 *     gitlab.com; without either it fails closed.
 *  4. `provider: 'auto'` (the default): a valid `baseUrl` selects gitlab with
 *     that host (a baseUrl is itself an explicit instance declaration);
 *     otherwise unanimous github remotes → github, a unanimous single-host
 *     GitLab-indicating remote set → gitlab, and anything else fails closed.
 */
export function resolveProviderSelection(
	input: ProviderSelectionInput,
): ProviderSelection {
	const provider = input.config?.provider ?? 'auto';
	const remotes = input.remotes;

	let baseUrlHost: string | undefined;
	const rawBaseUrl = input.config?.baseUrl ?? input.config?.base_url;
	if (rawBaseUrl !== undefined) {
		const raw = rawBaseUrl.trim();
		let parsed: URL;
		try {
			parsed = new URL(raw);
		} catch {
			return { ok: false, error: invalidBaseUrlError('not a valid URL') };
		}
		if (parsed.protocol !== 'https:') {
			return { ok: false, error: invalidBaseUrlError('must use HTTPS') };
		}
		const host = parsed.hostname.toLowerCase();
		if (hasNonAsciiHostname(host) || hasPunycodeLabel(host)) {
			return {
				ok: false,
				error: invalidBaseUrlError('non-ASCII (IDN) hosts are not allowed'),
			};
		}
		if (isPrivateHost(parsed)) {
			return {
				ok: false,
				error: invalidBaseUrlError(
					'private or localhost hosts are not allowed',
				),
			};
		}
		if (!host) {
			return { ok: false, error: invalidBaseUrlError('empty host') };
		}
		baseUrlHost = host;
	}

	if (provider === 'github') {
		if (baseUrlHost !== undefined) {
			return {
				ok: false,
				error:
					'Provider config conflict: forge.provider is "github" but forge.base_url is set — GitHub has a fixed base (github.com) and accepts no override. Remove base_url or set provider to "gitlab".',
			};
		}
		return {
			ok: true,
			context: { provider: 'github', host: GITHUB_CANONICAL_HOST },
		};
	}

	if (baseUrlHost !== undefined) {
		return { ok: true, context: { provider: 'gitlab', host: baseUrlHost } };
	}

	// No baseUrl: the host must come from a unanimously GitLab-indicating
	// remote set (explicit gitlab), or from unanimous auto-detection (auto).
	const gitlabHosts = new Set<string>();
	let sawGithub = false;
	let sawUnrecognized = false;
	for (const remote of remotes) {
		const parsed = parseForgeRemoteUrl(remote);
		if (!parsed) {
			sawUnrecognized = true;
			continue;
		}
		if (parsed.provider === 'github') {
			sawGithub = true;
		} else {
			gitlabHosts.add(parsed.host);
		}
	}

	if (provider === 'gitlab') {
		if (gitlabHosts.size === 1 && !sawGithub && !sawUnrecognized) {
			return {
				ok: true,
				context: { provider: 'gitlab', host: [...gitlabHosts][0] as string },
			};
		}
		return {
			ok: false,
			error:
				'Provider config incomplete: forge.provider is "gitlab" but no forge.base_url is set and the git remotes do not unanimously indicate a single GitLab host — set forge.base_url (e.g. https://gitlab.example.com) in config.',
		};
	}

	// auto
	if (sawGithub && gitlabHosts.size > 0) {
		return {
			ok: false,
			error:
				'Provider selection ambiguous: git remotes indicate both GitHub and GitLab — set forge.provider (and forge.base_url for self-hosted GitLab) explicitly in config.',
		};
	}
	if (sawUnrecognized) {
		return {
			ok: false,
			error:
				'Provider selection ambiguous: a git remote host matches no recognized provider (generic self-hosted) — set forge.provider and forge.base_url explicitly in config.',
		};
	}
	if (sawGithub) {
		return {
			ok: true,
			context: { provider: 'github', host: GITHUB_CANONICAL_HOST },
		};
	}
	if (gitlabHosts.size === 1) {
		return {
			ok: true,
			context: { provider: 'gitlab', host: [...gitlabHosts][0] as string },
		};
	}
	if (gitlabHosts.size > 1) {
		return {
			ok: false,
			error:
				'Provider selection ambiguous: git remotes indicate multiple different GitLab hosts — set forge.provider and forge.base_url explicitly in config.',
		};
	}
	return {
		ok: false,
		error:
			'Provider selection failed: no workflow-relevant git remote and no forge.base_url — set forge.provider (and forge.base_url for self-hosted GitLab) explicitly in config.',
	};
}
