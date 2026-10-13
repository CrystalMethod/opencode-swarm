/**
 * Feedback-round regression tests for PR #3206 (swarm-pr-review F-01..F-18 /
 * FB-001..FB-010 closure): pnpm v5 slash-form grammar, Berry alias identity,
 * local-protocol skips, CRLF handling, dist-tag fallback, file-level purl
 * dedup, adversarial-input linearity, NuGet hardening, and
 * ecosystem-qualified dedupe precedence.
 */
import { describe, expect, it } from 'bun:test';
import type { SbomComponent } from '../../../src/sbom/detectors/index';
import {
	dedupeSbomComponents,
	detectComponents,
} from '../../../src/sbom/detectors/index';

const setOf = (components: SbomComponent[]): string[] =>
	[...new Set(components.map((c) => `${c.name}@${c.version}`))].sort();

describe('sbom detectors — regression: pnpm v5 slash-form keys (#2956 feedback)', () => {
	it('parses /name/version keys incl. _peer suffixes and registry-host prefixes', () => {
		// lockfileVersion 5.0-5.4 writes slash-form keys; the @-split grammar
		// previously dropped plain/scoped keys and mangled _peer-suffixed ones
		// (the peer's @ drove a false name/version split).
		const lock = `lockfileVersion: '5.4'

packages:

  /express/4.18.2:
    resolution: {integrity: sha512-aaa}

  /@types/node/18.19.50:
    resolution: {integrity: sha512-bbb}

  /debug/4.3.4_supports-color@8.1.1:
    resolution: {integrity: sha512-ccc}

  /registry.example.invalid/lodash/4.17.21:
    resolution: {integrity: sha512-ddd}
`;
		expect(setOf(detectComponents('pnpm-lock.yaml', lock))).toEqual([
			'@types/node@18.19.50',
			'debug@4.3.4',
			'express@4.18.2',
			'lodash@4.17.21',
		]);
	});

	it('skips tarball/URL and file: keys — they are not registry components', () => {
		const v9Url = `packages:

  accountabstraction@https://codeload.github.com/eth-infinitism/account-abstraction/tar.gz/b36a1ed5:
    resolution: {integrity: sha512-bbb}
`;
		expect(detectComponents('pnpm-lock.yaml', v9Url)).toEqual([]);

		// Real vite v6.0.0 shape: `@scope/name@file:relative/path` — no `//`,
		// so this is a different class from the URL keys above.
		const v9File = `packages:

  '@vitejs/test-dep-with-asset-ext1.pdf@file:playground/optimize-deps/dep-with-asset-ext/dep1':
    resolution: {integrity: sha512-aaa}

  '@vitejs/test-dep-with-asset-ext2.pdf@file:playground/optimize-deps/dep-with-asset-ext/dep2':
    resolution: {integrity: sha512-bbb}

  express@4.18.2:
    resolution: {integrity: sha512-ccc}
`;
		expect(setOf(detectComponents('pnpm-lock.yaml', v9File))).toEqual([
			'express@4.18.2',
		]);
	});
});

describe('sbom detectors — regression: yarn Berry aliases record the real identity (#2956 feedback)', () => {
	it('resolves alias@npm:real@range to the real package name', () => {
		// `pkg:npm/debug@2.1.3` dereferences a different real npm package; the
		// alias key's true identity is the specifier target (`ms`).
		const berry = `"debug@npm:ms@^2.1.3":
  version: 2.1.3
  resolution: "debug@npm:ms@2.1.3"
`;
		expect(setOf(detectComponents('yarn.lock', berry))).toEqual(['ms@2.1.3']);
	});

	it('keeps non-alias npm: protocol specs under their own name', () => {
		const berry = `"left-pad@npm:1.0.0":
  version: 1.0.0
`;
		expect(setOf(detectComponents('yarn.lock', berry))).toEqual([
			'left-pad@1.0.0',
		]);
	});
});

describe('sbom detectors — regression: local/non-registry yarn protocols are skipped (#2956 feedback)', () => {
	it('skips file:, git:, github:, and https: specifiers', () => {
		const lock = `"my-lib@file:../my-lib":
  version "1.0.0"

"gitdep@github:user/repo#abc123":
  version "2.0.0"

"gitdep2@git+ssh://example.com/repo.git":
  version "3.0.0"

"urldep@https://example.com/pkg.tgz":
  version "4.0.0"

"registry-pkg@^2.0.0":
  version "2.1.0"
`;
		expect(setOf(detectComponents('yarn.lock', lock))).toEqual([
			'registry-pkg@2.1.0',
		]);
	});
});

describe('sbom detectors — regression: CRLF lockfiles parse identically (#2956 feedback)', () => {
	it('parses CRLF yarn and pnpm content', () => {
		const yarnCrlf = 'express@^4.18.0:\r\n  version "4.18.2"\r\n';
		expect(setOf(detectComponents('yarn.lock', yarnCrlf))).toEqual([
			'express@4.18.2',
		]);

		const pnpmCrlf =
			'packages:\r\n\r\n  express@4.18.2:\r\n    resolution: {integrity: sha512-aaa}\r\n';
		expect(setOf(detectComponents('pnpm-lock.yaml', pnpmCrlf))).toEqual([
			'express@4.18.2',
		]);
	});
});

describe('sbom detectors — regression: dist-tag fallback split (#2956 feedback)', () => {
	it('parses `*` and dist-tag specifiers via the last-@ fallback', () => {
		const lock = `glob@*:
  version "10.3.10"

rimraf@latest:
  version "5.0.5"
`;
		expect(setOf(detectComponents('yarn.lock', lock))).toEqual([
			'glob@10.3.10',
			'rimraf@5.0.5',
		]);
	});
});

describe('sbom detectors — file-level purl dedup is solely load-bearing (#2956 feedback)', () => {
	it('collapses two yarn blocks with the same resolved identity to one', () => {
		const lock = `chalk@^2.0.0:
  version "2.4.2"

chalk@^2.4.2:
  version "2.4.2"
`;
		const components = detectComponents('yarn.lock', lock);
		expect(components.length).toBe(1);
		expect(setOf(components)).toEqual(['chalk@2.4.2']);
	});

	it('collapses two pnpm keys with the same identity to one', () => {
		const lock = `packages:

  ms@2.1.3:
    resolution: {integrity: sha512-aaa}

  /ms@2.1.3:
    resolution: {integrity: sha512-bbb}
`;
		const components = detectComponents('pnpm-lock.yaml', lock);
		expect(components.length).toBe(1);
		expect(setOf(components)).toEqual(['ms@2.1.3']);
	});

	it('emits nothing for a package that appears ONLY under snapshots:', () => {
		const lock = `packages:

snapshots:

  express@4.18.2:
    dependencies:
      ms: 2.1.3
`;
		expect(detectComponents('pnpm-lock.yaml', lock)).toEqual([]);
	});
});

describe('sbom detectors — adversarial-input work stays linear (#2956 feedback)', () => {
	it('strips peer suffixes and quotes on huge hostile keys without stalling', () => {
		// Both fixtures carry the `packages:` header so the hostile keys
		// actually REACH the strip code (the section gate skips everything
		// above it); without it this test cannot detect a regression to the
		// quadratically-backtracking superseded regexes.
		const hostileParens = `packages:

  pkg@1.0.0${'('.repeat(200_000)}:
    resolution: {integrity: sha512-aaa}
`;
		const hostileQuotes = `packages:

  ${'"'.repeat(100_000)}pkg@1.0.0:
    resolution: {integrity: sha512-bbb}
`;
		const started = performance.now();
		detectComponents('pnpm-lock.yaml', hostileParens);
		detectComponents('pnpm-lock.yaml', hostileQuotes);
		const elapsed = performance.now() - started;
		// Linear handling finishes in milliseconds; the superseded
		// backtracking regexes took minutes on exercised inputs of this size.
		expect(elapsed).toBeLessThan(2000);
	});
});

describe('sbom detectors — NuGet hardening (#2956 feedback)', () => {
	it('skips null entries without truncating the rest of the file', () => {
		const lock = JSON.stringify({
			version: 1,
			dependencies: {
				'net8.0': {
					A: { type: 'Direct', resolved: '1.0.0' },
					B: null,
					C: { type: 'Transitive', resolved: '3.0.0' },
				},
			},
		});
		expect(setOf(detectComponents('packages.lock.json', lock))).toEqual([
			'A@1.0.0',
			'C@3.0.0',
		]);
	});

	it('treats non-string resolved/version values as absent', () => {
		const lock = JSON.stringify({
			version: 1,
			dependencies: {
				'net8.0': {
					Bad: { resolved: { nested: true } },
					Good: { version: '2.0.0' },
				},
			},
		});
		expect(setOf(detectComponents('packages.lock.json', lock))).toEqual([
			'Good@2.0.0',
		]);
	});

	it('emits each package once across multiple target frameworks', () => {
		const lock = JSON.stringify({
			version: 2,
			targets: {
				'net8.0': { 'Newtonsoft.Json/13.0.3': { type: 'Direct' } },
				'net6.0': { 'Newtonsoft.Json/13.0.3': { type: 'Direct' } },
			},
		});
		const components = detectComponents('packages.lock.json', lock);
		expect(components.length).toBe(1);
		expect(setOf(components)).toEqual(['Newtonsoft.Json@13.0.3']);
	});
});

describe('dedupeSbomComponents — ecosystem-qualified precedence (#2956 feedback)', () => {
	const npmUuid: SbomComponent = {
		name: 'uuid',
		version: '9.0.1',
		type: 'library',
		purl: 'pkg:npm/uuid@9.0.1',
	};
	const cargoUuid: SbomComponent = {
		name: 'uuid',
		version: '1.8.0',
		type: 'library',
		purl: 'pkg:cargo/uuid@1.8.0',
		license: 'Apache-2.0 OR MIT',
	};

	it('keeps a cross-ecosystem manifest entry that shares a lockfile name', () => {
		const merged = dedupeSbomComponents([npmUuid], [cargoUuid]);
		expect(merged.map((c) => c.purl)).toEqual([
			'pkg:npm/uuid@9.0.1',
			'pkg:cargo/uuid@1.8.0',
		]);
	});

	it('still suppresses the same-ecosystem declared-base twin', () => {
		const manifestTwin: SbomComponent = {
			name: 'uuid',
			version: '8.3.2',
			type: 'library',
			purl: 'pkg:npm/uuid@8.3.2',
		};
		const merged = dedupeSbomComponents([npmUuid], [manifestTwin]);
		expect(merged.map((c) => c.purl)).toEqual(['pkg:npm/uuid@9.0.1']);
	});

	it('falls back to name-only suppression when purls are absent', () => {
		const bareLock: SbomComponent = {
			name: 'uuid',
			version: '9.0.1',
			type: 'library',
		};
		const bareManifest: SbomComponent = {
			name: 'uuid',
			version: '8.3.2',
			type: 'library',
		};
		expect(dedupeSbomComponents([bareLock], [bareManifest]).length).toBe(1);
	});
});
