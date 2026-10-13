/**
 * .NET Detector
 *
 * Supports: packages.lock.json, paket.lock
 */

import type { Detector, SbomComponent } from './index.js';
import { generatePurl } from './index.js';

/**
 * Parse packages.lock.json (NuGet lock file)
 *
 * Format:
 * {
 *   "version": 2,
 *   "dependencies": {
 *     "net6.0": {
 *       "Newtonsoft.Json": {
 *         "type": "Direct",
 *         "requested": "[13.0.1, )",
 *         "resolved": "13.0.1"
 *       }
 *     }
 *   },
 *   "targets": {
 *     "net6.0": {
 *       "Newtonsoft.Json/13.0.1": {
 *         "type": "Direct",
 *         "dependencies": {}
 *       }
 *     }
 *   }
 * }
 */
function parsePackagesLockJson(content: string): SbomComponent[] {
	const components: SbomComponent[] = [];
	const seenPurls = new Set<string>();

	try {
		const lock = JSON.parse(content);

		// Try to get dependencies from targets (more accurate)
		const targets = lock.targets || lock.dependencies || {};

		for (const [_target, targetDeps] of Object.entries(targets)) {
			if (!targetDeps || typeof targetDeps !== 'object') continue;

			for (const [pkgSpec, pkgData] of Object.entries(targetDeps)) {
				// A null/scalar entry must be skipped, never dereferenced — a
				// throw here would silently truncate everything collected so far.
				if (!pkgData || typeof pkgData !== 'object') continue;
				const pkg = pkgData as Record<string, unknown>;

				let name: string;
				let version: string;
				if (pkgSpec.includes('/')) {
					// v2 `targets` shape: keys are `Name/Version`
					const [specName, specVersion] = pkgSpec.split('/');
					name = specName;
					version = specVersion;
				} else {
					// v1 `dependencies` fallback shape: keys are bare NuGet IDs
					// (IDs cannot contain '/'); the resolved version rides in the
					// entry body as a string.
					name = pkgSpec;
					version =
						typeof pkg.resolved === 'string'
							? pkg.resolved
							: typeof pkg.version === 'string'
								? pkg.version
								: '';
				}

				if (name && version) {
					// Multi-TFM lockfiles repeat each package per target framework;
					// emit it once.
					const purl = generatePurl('nuget', name, version);
					if (seenPurls.has(purl)) continue;
					seenPurls.add(purl);
					components.push({
						name,
						version,
						type: 'library',
						purl,
						license: pkg.license as string | undefined,
					});
				}
			}
		}
	} catch {
		// Invalid JSON
	}

	return components;
}

/**
 * Parse paket.lock (Paket lock file)
 *
 * Format:
 * NUGET
 *   remote: https://www.nuget.org/api/v2
 *     Newtonsoft.Json (13.0.1)
 *       -> Newtonsoft.Json (13.0.1)
 */
function parsePaketLock(content: string): SbomComponent[] {
	const components: SbomComponent[] = [];

	const lines = content.split('\n');
	let inNuGetSection = false;

	for (const line of lines) {
		const trimmed = line.trim();

		if (trimmed === 'NUGET' || trimmed.startsWith('NUGET')) {
			inNuGetSection = true;
			continue;
		}

		if (trimmed === 'GITHUB' || trimmed.startsWith('GITHUB')) {
			inNuGetSection = false;
			continue;
		}

		if (!inNuGetSection) continue;
		if (!trimmed || trimmed.startsWith('remote:') || trimmed.startsWith('->'))
			continue;

		// Match: package-name (version)
		const match = trimmed.match(/^([a-zA-Z0-9_.-]+)\s+\(([^)]+)\)/);
		if (match) {
			const name = match[1];
			const version = match[2];

			if (name && version) {
				components.push({
					name,
					version,
					type: 'library',
					purl: generatePurl('nuget', name, version),
				});
			}
		}
	}

	return components;
}

export const dotnetDetectors: Detector[] = [
	{
		name: '.NET packages.lock.json',
		patterns: ['packages.lock.json'],
		detect: (_filePath, content) => {
			return parsePackagesLockJson(content);
		},
	},
	{
		name: '.NET paket.lock',
		patterns: ['paket.lock'],
		detect: (_filePath, content) => {
			return parsePaketLock(content);
		},
	},
];
