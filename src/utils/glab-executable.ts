/**
 * Single source of truth for "what absolute path do we invoke for glab" — the
 * glab twin of `src/utils/gh-executable.ts` (issue #2733, GitLab provider).
 *
 * Built to the SAME contract as the gh resolver (the maintainer-verified shape
 * for this feature, and issue #2262/#2476's hardening for gh):
 *
 *   1. explicit override — the `OPENCODE_SWARM_GLAB_BINARY` env var ONLY
 *      (no config-file key; env-only keeps every override user-controlled);
 *   2. platform absolute candidates first;
 *   3. ALL PATH matches for `glab` (win32: `.exe`/`.cmd`/`.bat` variants);
 *   4. bare `'glab'` LAST, unprobed.
 *
 * Each non-bare candidate must be ABSOLUTE and is validated once with
 * `glab --version` whose output must match GLAB_VERSION_PATTERN
 * (`glab version 1.65.0 (...)` — https://docs.gitlab.com/cli). Same
 * accident-not-attacker contract as the gh probe.
 *
 * Bounded probing mirrors gh exactly (enforced by
 * tests/unit/utils/forge-executable-parity.test.ts): per-probe timeout 250 ms,
 * total first-resolution budget 1000 ms, negative-cache TTL 60 s. Resolution
 * is LAZY (never plugin init) and NEVER throws — both non-accepting outcomes
 * return the bare `'glab'` fallback so a host that works via plain PATH
 * lookup never regresses. The probe/candidate machinery is one
 * parameterized core so the glab twin cannot silently drift from the gh
 * discipline it must track.
 */
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { advisoryWarn } from '../services/warning-buffer.js';

/** Env var escape hatch — a blocked user can set this without editing files. */
export const GLAB_BINARY_ENV_VAR = 'OPENCODE_SWARM_GLAB_BINARY';

export const PER_PROBE_TIMEOUT_MS = 250;
export const TOTAL_BUDGET_MS = 1000;
export const NEGATIVE_CACHE_TTL_MS = 60_000;

const BARE_GLAB = 'glab';
const PROBE_MAX_BUFFER_BYTES = 64 * 1024;
const PROBE_OUTPUT_EXCERPT_CHARS = 60;

const WINDOWS_PATH_EXTENSIONS = ['.exe', '.cmd', '.bat'];

/**
 * `glab --version` prints `glab version 1.65.0 (...)` — a fixed format string
 * in glab's own root command. Anchored to the first line, like
 * `GH_VERSION_PATTERN`.
 */
export const GLAB_VERSION_PATTERN = /^glab version \d+\.\d+/;

function excerptProbeOutput(raw: string): string {
	return raw
		.slice(0, PROBE_OUTPUT_EXCERPT_CHARS)
		.replace(/[^\x20-\x7E]/g, ' ')
		.trim();
}

export type GlabResolutionCandidateSource = 'override' | 'platform' | 'path';

export interface GlabResolutionAttempt {
	source: GlabResolutionCandidateSource;
	candidate: string;
	accepted: boolean;
	/** Rejection reason; absent when `accepted` is true. */
	reason?: string;
}

export interface GlabResolutionDescription {
	resolved: boolean;
	resolvedPath?: string;
	attempts: GlabResolutionAttempt[];
	overrideValue?: string;
}

interface CacheSuccess {
	kind: 'success';
	path: string;
}
interface CacheFallback {
	kind: 'fallback';
	expiresAt: number;
}
type CacheEntry = CacheSuccess | CacheFallback;

/** Module state — lazy, memoized on first call; same bounds as gh. */
let cache: CacheEntry | null = null;
let lastAttempts: GlabResolutionAttempt[] = [];
let cacheGeneration = 0;

/**
 * Windows install locations for glab (same ProgramFiles/LOCALAPPDATA layout
 * gh uses, under a `GitLab CLI` directory).
 */
export function windowsGlabAbsoluteCandidates(
	env: NodeJS.ProcessEnv,
): string[] {
	const candidates: string[] = [];
	const push = (...parts: string[]): void => {
		const candidate = path.join(...parts);
		if (!candidates.includes(candidate)) candidates.push(candidate);
	};
	if (env.ProgramFiles) {
		push(env.ProgramFiles, 'GitLab CLI', 'glab.exe');
	}
	if (env['ProgramFiles(x86)']) {
		push(env['ProgramFiles(x86)'], 'GitLab CLI', 'glab.exe');
	}
	if (env.LOCALAPPDATA) {
		push(env.LOCALAPPDATA, 'GitLab CLI', 'glab.exe');
		push(env.LOCALAPPDATA, 'Programs', 'GitLab CLI', 'glab.exe');
	}
	return candidates;
}

function platformCandidates(
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
): string[] {
	if (platform === 'win32') {
		return windowsGlabAbsoluteCandidates(env);
	}
	if (platform === 'darwin') {
		return ['/opt/homebrew/bin/glab', '/usr/local/bin/glab', '/usr/bin/glab'];
	}
	// linux and other POSIX platforms
	return ['/usr/bin/glab', '/usr/local/bin/glab', '/bin/glab'];
}

function isAbsoluteForPlatform(
	candidate: string,
	platform: NodeJS.Platform,
): boolean {
	return platform === 'win32'
		? path.win32.isAbsolute(candidate)
		: path.posix.isAbsolute(candidate);
}

function joinDirAndName(
	dir: string,
	name: string,
	platform: NodeJS.Platform,
): string {
	const sep = platform === 'win32' ? '\\' : '/';
	const trimmed = dir.replace(/[\\/]+$/, '');
	return trimmed ? `${trimmed}${sep}${name}` : `${sep}${name}`;
}

/** ALL PATH matches for `glab` — not just the first hit. */
function pathCandidates(platform: NodeJS.Platform): string[] {
	const pathValue = _internals.env().PATH ?? '';
	if (!pathValue) return [];
	const dirs = pathValue
		.split(platform === 'win32' ? ';' : ':')
		.filter(Boolean);
	const names =
		platform === 'win32'
			? [...WINDOWS_PATH_EXTENSIONS.map((ext) => `glab${ext}`), 'glab']
			: ['glab'];
	const out: string[] = [];
	for (const dir of dirs) {
		for (const name of names) {
			const candidate = joinDirAndName(dir, name, platform);
			if (!out.includes(candidate)) out.push(candidate);
		}
	}
	return out;
}

function envOverride(): string | undefined {
	const raw = _internals.env()[GLAB_BINARY_ENV_VAR];
	return raw && raw.trim() !== '' ? raw : undefined;
}

interface Candidate {
	source: GlabResolutionCandidateSource;
	path: string;
}

function buildCandidates(platform: NodeJS.Platform): Candidate[] {
	const override = envOverride();
	const overrideCandidate: Candidate[] = override
		? [{ source: 'override', path: override }]
		: [];

	const seen = new Set<string>(overrideCandidate.map((c) => c.path));
	const rest: Candidate[] = [];
	for (const p of platformCandidates(platform, _internals.env())) {
		if (seen.has(p)) continue;
		seen.add(p);
		rest.push({ source: 'platform', path: p });
	}
	for (const p of pathCandidates(platform)) {
		if (seen.has(p)) continue;
		seen.add(p);
		rest.push({ source: 'path', path: p });
	}
	return [...overrideCandidate, ...rest];
}

function probeCandidate(
	candidatePath: string,
	platform: NodeJS.Platform,
): { accepted: true } | { accepted: false; reason: string } {
	if (!isAbsoluteForPlatform(candidatePath, platform)) {
		return { accepted: false, reason: 'not an absolute path' };
	}

	let stat: fs.Stats;
	try {
		stat = fs.statSync(candidatePath);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === 'ENOENT') return { accepted: false, reason: 'no such file' };
		return {
			accepted: false,
			reason: `cannot stat (${code ?? 'unknown error'})`,
		};
	}
	if (stat.isDirectory()) {
		return { accepted: false, reason: 'is a directory' };
	}
	if (!stat.isFile()) {
		return { accepted: false, reason: 'not a regular file' };
	}

	let result: SpawnSyncReturns<Buffer>;
	try {
		result = _internals.spawnSync(candidatePath, ['--version'], {
			cwd: os.tmpdir(),
			stdio: ['ignore', 'pipe', 'ignore'],
			windowsHide: true,
			timeout: PER_PROBE_TIMEOUT_MS,
			maxBuffer: PROBE_MAX_BUFFER_BYTES,
		});
	} catch (err) {
		return {
			accepted: false,
			reason: `spawn threw: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	if (result.error) {
		return { accepted: false, reason: `spawn failed: ${result.error.message}` };
	}
	if (result.status !== 0) {
		const statusDescription =
			result.status !== null
				? `exit ${result.status}`
				: `signal ${result.signal ?? 'unknown'}`;
		return {
			accepted: false,
			reason: `glab --version returned ${statusDescription}`,
		};
	}

	const versionOutput = (result.stdout ?? '').toString().trim();
	if (!GLAB_VERSION_PATTERN.test(versionOutput)) {
		const excerpt = excerptProbeOutput(versionOutput);
		return {
			accepted: false,
			reason: excerpt
				? `not glab: --version printed "${excerpt}"`
				: 'not glab: --version printed nothing',
		};
	}
	return { accepted: true };
}

type ProbeCycleResult =
	| { outcome: 'accepted'; path: string }
	| { outcome: 'exhausted-budget' }
	| { outcome: 'all-rejected' };

function probeCycle(
	candidates: Candidate[],
	platform: NodeJS.Platform,
	attempts: GlabResolutionAttempt[],
): ProbeCycleResult {
	const start = _internals.now();
	let budgetExceeded = false;

	for (const candidate of candidates) {
		if (_internals.now() - start > TOTAL_BUDGET_MS) {
			budgetExceeded = true;
			break;
		}
		const result = probeCandidate(candidate.path, platform);
		attempts.push({
			source: candidate.source,
			candidate: candidate.path,
			accepted: result.accepted,
			reason: result.accepted ? undefined : result.reason,
		});
		if (candidate.source === 'override' && !result.accepted) {
			// Parity with gh-executable.ts (PRR-006): a rejected operator
			// override must not fall through silently.
			advisoryWarn(
				`[opencode-swarm] ${GLAB_BINARY_ENV_VAR} override "${candidate.path}" is unusable (${result.reason}); falling back to automatic glab resolution.`,
			);
		}
		if (result.accepted) {
			return { outcome: 'accepted', path: candidate.path };
		}
	}

	return budgetExceeded
		? { outcome: 'exhausted-budget' }
		: { outcome: 'all-rejected' };
}

function readCache(): CacheEntry | null {
	if (cache === null) return null;
	if (cache.kind === 'success') return cache;
	if (_internals.now() < cache.expiresAt) return cache;
	cache = null;
	return null;
}

function applyProbeResult(
	result: ProbeCycleResult,
	attempts: GlabResolutionAttempt[],
	generation: number,
): string {
	if (generation !== cacheGeneration) {
		// Stale cycle (cache reset mid-probe): hand the caller what WAS
		// validated, leave cache/lastAttempts untouched.
		return result.outcome === 'accepted' ? result.path : BARE_GLAB;
	}
	lastAttempts = attempts;
	if (result.outcome === 'accepted') {
		cache = { kind: 'success', path: result.path };
		return result.path;
	}
	cache = {
		kind: 'fallback',
		expiresAt: _internals.now() + NEGATIVE_CACHE_TTL_MS,
	};
	return BARE_GLAB;
}

/**
 * Resolve the glab executable to invoke. Lazy, memoized, bounded by
 * TOTAL_BUDGET_MS, never throws. Returns a validated absolute path or the
 * bare `'glab'` fallback.
 */
export function resolveGlabExecutable(): string {
	const cached = readCache();
	if (cached) return cached.kind === 'success' ? cached.path : BARE_GLAB;

	const platform = _internals.platform();
	const attempts: GlabResolutionAttempt[] = [];
	const generation = cacheGeneration;
	const candidates = buildCandidates(platform);

	const result = probeCycle(candidates, platform, attempts);
	return applyProbeResult(result, attempts, generation);
}

/** Exported for tests; clears the memoized cache (and bumps the generation). */
export function resetGlabExecutableCache(): void {
	cache = null;
	lastAttempts = [];
	cacheGeneration++;
}

/**
 * TEST-ONLY seam — NOT a production API, do not call from `src/`. Pre-seeds
 * the resolver cache with an explicit "success" entry so
 * `resolveGlabExecutable()` returns `value` with zero probe spawns.
 */
export function __seedGlabExecutableForTests(value: string): void {
	cache = { kind: 'success', path: value };
}

/** Diagnostic surface: candidates tried in the most recent probe cycle. */
export function describeGlabResolution(): GlabResolutionDescription {
	const cached = cache;
	return {
		resolved: cached?.kind === 'success',
		resolvedPath: cached?.kind === 'success' ? cached.path : undefined,
		attempts: [...lastAttempts],
		overrideValue: envOverride(),
	};
}

/**
 * DI seam for testability (repo convention — see gh-executable.ts).
 * `platform`/`env` let tests drive every platform branch regardless of the
 * host OS; `now` makes the TTL and budget deterministically testable.
 */
export const _internals: {
	spawnSync: typeof spawnSync;
	platform: () => NodeJS.Platform;
	env: () => NodeJS.ProcessEnv;
	now: () => number;
} = {
	spawnSync,
	platform: () => process.platform,
	env: () => process.env,
	now: () => Date.now(),
};
