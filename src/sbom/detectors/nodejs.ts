/**
 * Node.js Detector
 *
 * Supports: package.json, package-lock.json, yarn.lock, pnpm-lock.yaml
 */

import type { Detector, SbomComponent } from './index.js';
import { generatePurl } from './index.js';

/**
 * Parse package.json dependencies (fallback)
 */
function parsePackageJson(content: string): SbomComponent[] {
	const components: SbomComponent[] = [];

	try {
		const pkg = JSON.parse(content);

		// Handle both dependencies and devDependencies
		const deps = { ...pkg.dependencies, ...pkg.devDependencies };

		for (const [name, version] of Object.entries(deps)) {
			const ver = String(version);
			// Remove version prefixes like ^, ~, >=, etc. for PURL
			const cleanVersion = ver.replace(/^[\^~>=<]+/, '');

			components.push({
				name,
				version: cleanVersion || 'unknown',
				type: 'library',
				purl: generatePurl('npm', name, cleanVersion || 'unknown'),
			});
		}
	} catch {
		// Invalid JSON, return empty
	}

	return components;
}

/**
 * Parse package-lock.json (npm v1/v2/v3 lockfile format)
 */
function parsePackageLock(content: string): SbomComponent[] {
	const components: SbomComponent[] = [];

	try {
		const lock = JSON.parse(content);

		// Handle different lockfile versions
		const packages = lock.packages || lock.dependencies || {};

		for (const [pkgPath, pkgData] of Object.entries(packages)) {
			if (pkgPath === '') continue; // Skip root package

			const pkg = pkgData as Record<string, unknown>;
			const version = (pkg.version as string) || '';
			// The package name is the last `node_modules/` segment of the key
			// (`node_modules/@types/node` -> `@types/node`,
			// `node_modules/debug/node_modules/ms` -> `ms`); v1
			// `dependencies` keys are already bare names and pass through.
			const name =
				(pkg.name as string) ||
				(pkgPath.includes('node_modules/')
					? pkgPath.slice(
							pkgPath.lastIndexOf('node_modules/') + 'node_modules/'.length,
						)
					: pkgPath);

			if (name && version) {
				components.push({
					name,
					version,
					type: 'library',
					purl: generatePurl('npm', name, version),
					license: pkg.license as string | undefined,
				});
			}
		}
	} catch {
		// Invalid JSON
	}

	return components;
}

/**
 * Trim leading/trailing quote characters without regex backtracking
 * (a `/^["']+/ … /["']+$/` pair is quadratic on interior quote runs).
 */
function trimQuoteChars(value: string): string {
	let start = 0;
	let end = value.length;
	while (start < end && (value[start] === '"' || value[start] === "'")) {
		start++;
	}
	while (end > start && (value[end - 1] === '"' || value[end - 1] === "'")) {
		end--;
	}
	return value.slice(start, end);
}

const PROTOCOL_LIKE = /^[a-z][a-z0-9+.-]*:/;

/**
 * Split a yarn dependency spec into name and raw specifier.
 *
 * The separator is the first `@` (after a possible scope) whose remainder
 * starts a protocol (`npm:`, `workspace:`, `patch:`, …) or a version range
 * — Berry patch specs embed further `@` signs (`pkg@patch:pkg@npm%3A1.0.0#…`),
 * so a last-`@` split would mis-parse them. Falls back to the last `@` for
 * plain dist-tag specifiers. The `npm:` protocol is NOT stripped here; the
 * caller needs it to resolve Berry aliases.
 */
function splitYarnSpec(
	spec: string,
): { name: string; specifier: string } | null {
	const rangeLike = /^[\d^~>=<]/;
	for (let i = 1; i < spec.length; i++) {
		if (spec[i] !== '@') continue;
		const rest = spec.slice(i + 1);
		if (PROTOCOL_LIKE.test(rest) || rangeLike.test(rest)) {
			return { name: spec.slice(0, i), specifier: rest };
		}
	}
	const last = spec.lastIndexOf('@');
	if (last <= 0) return null;
	return { name: spec.slice(0, last), specifier: spec.slice(last + 1) };
}

/**
 * Parse yarn.lock (classic and Berry formats)
 *
 * A block header is a column-0 line ending in `:` whose content is a
 * comma-separated list of dependency specs (each optionally quoted; Berry
 * wraps whole lists in one quote pair). The resolved version comes from the
 * block's first `version "X"` (classic) or `version: X` (Berry) line, never
 * from the key's specifier. Berry aliases (`alias@npm:real@range`) are
 * recorded under the REAL package identity from the specifier.
 */
function parseYarnLock(content: string): SbomComponent[] {
	const components: SbomComponent[] = [];
	const seenPurls = new Set<string>();

	let blockNames: string[] = [];
	const blockNameSet = new Set<string>();
	let blockVersion = '';

	const flushBlock = () => {
		for (const name of blockNames) {
			if (!blockVersion) continue;
			const purl = generatePurl('npm', name, blockVersion);
			if (seenPurls.has(purl)) continue;
			seenPurls.add(purl);
			components.push({
				name,
				version: blockVersion,
				type: 'library',
				purl,
			});
		}
		blockNames = [];
		blockNameSet.clear();
		blockVersion = '';
	};

	for (const rawLine of content.split('\n')) {
		const line = rawLine.replace(/\r$/, '');
		const isHeader =
			line.length > 0 && !/[ \t]/.test(line[0]) && line.trimEnd().endsWith(':');

		if (isHeader) {
			flushBlock();
			const header = line.trimEnd().slice(0, -1);
			for (const rawSpec of header.split(',')) {
				const spec = trimQuoteChars(rawSpec.trim());
				const split = splitYarnSpec(spec);
				if (!split) continue; // no name@specifier split (e.g. __metadata)
				let { name, specifier } = split;
				if (specifier.startsWith('npm:')) {
					// Berry alias: `alias@npm:real@range` resolves to the REAL
					// package; record that identity, not the local alias name.
					specifier = specifier.slice(4);
					const innerAt = specifier.lastIndexOf('@');
					if (innerAt > 0) name = specifier.slice(0, innerAt);
				} else if (PROTOCOL_LIKE.test(specifier)) {
					// workspace:/patch:/portal:/link:/file:/git:/github:/http(s):
					// are local or non-registry — not registry components.
					continue;
				}
				if (name && !blockNameSet.has(name)) {
					blockNameSet.add(name);
					blockNames.push(name);
				}
			}
			continue;
		}

		if (blockNames.length > 0 && !blockVersion) {
			const versionMatch = line.match(/^\s*version(?::\s*|["\s]+)([^\s"']+)/);
			if (versionMatch) blockVersion = versionMatch[1];
		}
	}
	flushBlock();

	return components;
}

/**
 * Parse pnpm-lock.yaml (v5 through v9 formats)
 *
 * Registry packages live only under the top-level `packages:` section
 * (v5/v6 also accept the legacy `/packages:` header shape). Two key
 * grammars: v6+ writes `[/]name@version[(peer-specs)]:` (v9 drops the
 * leading slash and YAML-single-quotes scoped names); v5.0-5.4 writes
 * `/[host/]name[/scope/name]/version[_peer@x]:`. Peer-suffix parentheses
 * and underscore peer suffixes carry no version.
 */
function parsePnpmLockYaml(content: string): SbomComponent[] {
	const components: SbomComponent[] = [];
	const seenPurls = new Set<string>();

	let inPackages = false;

	for (const rawLine of content.split('\n')) {
		const line = rawLine.replace(/\r$/, '');

		if (line.length > 0 && !/[ \t]/.test(line[0])) {
			inPackages = /^\/?packages\s*:/.test(line);
			continue;
		}
		if (!inPackages) continue;

		const trimmed = line.trim();
		if (!trimmed.endsWith(':')) continue; // nested `key: value` lines are not keys
		if (trimmed.includes('://')) continue; // tarball/git URL keys are not registry components

		let key = trimQuoteChars(trimmed.slice(0, -1));
		// Peer suffixes start at the first `(` — npm names cannot contain
		// parentheses, so cutting there is linear and handles nesting.
		const paren = key.indexOf('(');
		if (paren >= 0) key = key.slice(0, paren);
		if (key.startsWith('/')) key = key.slice(1);

		// v6+ @-form: `name[@scope/name]@version` — at most one slash that
		// belongs to a leading @scope. Anything else with a slash is v5-form.
		const atForm = /^(@[^/]+\/)?[^/@]+@/.test(key);

		let name: string;
		let version: string;
		if (atForm) {
			const at = key.lastIndexOf('@');
			if (at <= 0) continue; // block headers like `dependencies:` carry no version
			name = key.slice(0, at);
			version = key.slice(at + 1);
			// pnpm `file:`/`link:` keys (real shape: `@scope/pkg@file:path` — no
			// `//`, so the URL pre-filter above cannot catch them) are local
			// paths, not registry components.
			if (PROTOCOL_LIKE.test(version)) continue;
		} else {
			// v5 slash-form: `[host/]name[/scope]/version` — the version is the
			// last segment; a dotted first segment is a registry host prefix.
			const slash = key.lastIndexOf('/');
			if (slash <= 0) continue; // `dependencies:` headers carry no version
			version = key.slice(slash + 1);
			name = key.slice(0, slash);
			const hostEnd = name.indexOf('/');
			if (hostEnd > 0 && /^[^/@]+\.[^/@]+$/.test(name.slice(0, hostEnd))) {
				name = name.slice(hostEnd + 1);
			}
			const peer = version.indexOf('_');
			if (peer > 0) version = version.slice(0, peer); // v5 `_peer@x` suffix
		}
		if (!name || !version || !/\d/.test(version)) continue;

		const purl = generatePurl('npm', name, version);
		if (seenPurls.has(purl)) continue;
		seenPurls.add(purl);
		components.push({
			name,
			version,
			type: 'library',
			purl,
		});
	}

	return components;
}

export const nodejsDetectors: Detector[] = [
	{
		name: 'Node.js package-lock.json',
		patterns: ['package-lock.json'],
		detect: (_filePath, content) => {
			return parsePackageLock(content);
		},
	},
	{
		name: 'Node.js yarn.lock',
		patterns: ['yarn.lock'],
		detect: (_filePath, content) => {
			return parseYarnLock(content);
		},
	},
	{
		name: 'Node.js pnpm-lock.yaml',
		patterns: ['pnpm-lock.yaml'],
		detect: (_filePath, content) => {
			return parsePnpmLockYaml(content);
		},
	},
	{
		name: 'Node.js package.json',
		patterns: ['package.json'],
		detect: (_filePath, content) => {
			return parsePackageJson(content);
		},
	},
];
