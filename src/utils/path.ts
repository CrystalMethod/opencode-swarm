import * as path from 'node:path';

export function normalizePath(p: string): string {
	if (!p) return '';
	let result = p
		.replace(/\\/g, '/')
		.replace(/\/+/g, '/')
		.replace(/^\.\//, '')
		.replace(/(?:^|\/)\.\//g, '/');
	result = result.replace(/\/$/, '');
	result = result.replace(/\/\.$/, '');
	if (process.platform === 'win32') result = result.toLowerCase();
	if (!result) {
		// Preserve documented contract: both '.' and './' normalize to '.'
		const norm = p.replace(/\\/g, '/');
		if (norm === '.' || norm === './') return '.';
		return '';
	}
	return result;
}

/**
 * Canonicalize one per-task file-attribution entry to the portable form used
 * by `modifiedFilesByTask` (issue #2925): repo-relative against the writer's
 * workspace directory, forward-slashed, win32-case-folded via
 * {@link normalizePath}.
 *
 * Returns null (drop) for entries that cannot be proven canonical:
 * - absolute input without a `workspaceDirectory` (no base to resolve
 *   against — storing it raw is exactly the pre-#2925 defect);
 * - any input whose resolved form escapes the workspace (`..`-prefixed or
 *   absolute relative, e.g. a different drive on win32);
 * - relative input with a `..` segment when no base is available (a leading
 *   or inner `..` can never appear in a repo-relative path);
 * - empty/whitespace-only input, or a path that collapses to '.' (the
 *   workspace root itself is not a file entry).
 *
 * Entries are advisory, so drops are silent by contract (the caller never
 * throws on a dropped entry). The snapshot deserializer
 * (`deserializeModifiedFilesByTask`) intentionally sits OUTSIDE this
 * boundary: legacy raw entries round-trip verbatim from old snapshots and
 * remain covered by read-side canonicalization.
 */
export function canonicalAttributionPath(
	raw: string,
	workspaceDirectory?: string,
): string | null {
	if (typeof raw !== 'string') return null;
	const cleaned = raw.trim();
	if (!cleaned) return null;
	// Mirror the sibling boundaries (stage-b-gates normalizeAttributionPath
	// and isBoundedGenerationValue): entries are advisory, so reject
	// control-character and oversized inputs instead of storing them.
	if (cleaned.length > 4096) return null;
	for (let i = 0; i < cleaned.length; i++) {
		const code = cleaned.charCodeAt(i);
		if (code <= 31 || code === 127) return null;
	}

	const base =
		typeof workspaceDirectory === 'string' && workspaceDirectory.trim()
			? path.resolve(workspaceDirectory.trim())
			: null;

	let relative: string;
	if (path.isAbsolute(cleaned)) {
		if (base === null) return null;
		relative = path.relative(base, path.resolve(cleaned));
	} else if (base !== null) {
		relative = path.relative(base, path.resolve(base, cleaned));
	} else {
		// No base: only syntactic canonicalization is possible. A `..`
		// segment can never be part of a canonical repo-relative path.
		const forward = cleaned.replace(/\\/g, '/');
		if (forward.split('/').includes('..')) return null;
		relative = forward;
	}

	if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
		return null;
	}
	const normalized = normalizePath(relative);
	if (!normalized || normalized === '.') return null;
	return normalized;
}
