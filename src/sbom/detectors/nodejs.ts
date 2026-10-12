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
 * Split a yarn dependency spec into name and specifier.
 *
 * The separator is the first `@` (after a possible scope) whose remainder
 * starts a protocol (`npm:`, `workspace:`, `patch:`, …) or a version range
 * — Berry patch specs embed further `@` signs (`pkg@patch:pkg@npm%3A1.0.0#…`),
 * so a last-`@` split would mis-parse them. Falls back to the last `@` for
 * plain dist-tag specifiers.
 */
function splitYarnSpec(
	spec: string,
): { name: string; specifier: string } | null {
	const schemeLike = /^[a-z][a-z0-9+.-]*:/;
	const rangeLike = /^[\d^~>=<]/;
	for (let i = 1; i < spec.length; i++) {
		if (spec[i] !== '@') continue;
		const rest = spec.slice(i + 1);
		if (schemeLike.test(rest) || rangeLike.test(rest)) {
			return {
				name: spec.slice(0, i),
				specifier: rest.startsWith('npm:') ? rest.slice(4) : rest,
			};
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
 * from the key's specifier.
 */
function parseYarnLock(content: string): SbomComponent[] {
	const components: SbomComponent[] = [];
	const seenPurls = new Set<string>();

	let blockNames: string[] = [];
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
				const spec = rawSpec
					.trim()
					.replace(/^["'](.*)["']$/, '$1')
					.replace(/^["']+/, '')
					.replace(/["']+$/, '');
				const split = splitYarnSpec(spec);
				if (!split) continue; // no name@specifier split (e.g. __metadata)
				const { name, specifier } = split;
				if (
					specifier.startsWith('workspace:') ||
					specifier.startsWith('patch:') ||
					specifier.startsWith('portal:') ||
					specifier.startsWith('link:')
				) {
					continue; // local protocols are not registry components
				}
				if (name && !blockNames.includes(name)) blockNames.push(name);
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
 * Parse pnpm-lock.yaml (v5/v6/v9 formats)
 *
 * Registry packages live only under the top-level `packages:` section
 * (v5/v6 also accept the legacy `/packages:` header shape). Keys are
 * `[/]name@version[(peer-specs)]:` — pnpm v9 dropped the leading slash and
 * YAML-single-quotes scoped names; peer-suffix parentheses carry no version.
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

		let key = trimmed.slice(0, -1);
		key = key.replace(/^["'](.*)["']$/, '$1');
		key = key.replace(/(\([^)]*\))+$/, '');
		if (key.startsWith('/')) key = key.slice(1);

		const at = key.lastIndexOf('@');
		if (at <= 0) continue; // block headers like `dependencies:` carry no version

		const name = key.slice(0, at);
		const version = key.slice(at + 1);
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
