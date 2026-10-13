/**
 * Per-parser regression tests for issue #2956 (SBOM lockfile parser truth).
 *
 * Each block pins a shape the pre-fix parsers dropped or mangled; the
 * matrix suite (lockfile-matrix.test.ts) owns whole-file exact-set truth.
 */
import { describe, expect, it } from 'bun:test';
import type { SbomComponent } from '../../../src/sbom/detectors/index';
import {
	dedupeSbomComponents,
	detectComponents,
} from '../../../src/sbom/detectors/index';

const setOf = (components: SbomComponent[]): string[] =>
	[...new Set(components.map((c) => `${c.name}@${c.version}`))].sort();

describe('sbom detectors — regression: yarn classic drops non-pinned keys (#2956)', () => {
	it('parses range keys, quoted scoped keys, and comma multi-keys at the block version', () => {
		// Previous code matched only exact-pinned unscoped keys and never read
		// the block version line: express@^4.18.0, "@babel/core@^7.23.0", and
		// chalk@^2.0.0, chalk@^2.4.2 were all dropped.
		const lock = `lodash@4.17.21:
  version "4.17.21"

express@^4.18.0:
  version "4.18.2"

"@babel/core@^7.23.0":
  version "7.23.9"

chalk@^2.0.0, chalk@^2.4.2:
  version "2.4.2"
`;
		expect(setOf(detectComponents('yarn.lock', lock))).toEqual([
			'@babel/core@7.23.9',
			'chalk@2.4.2',
			'express@4.18.2',
			'lodash@4.17.21',
		]);
	});

	it('parses per-spec-quoted multi-lists without leaking quote characters', () => {
		const lock = `"@babel/code-frame@^7.0.0", "@babel/code-frame@^7.10.4":
  version "7.10.4"
`;
		expect(setOf(detectComponents('yarn.lock', lock))).toEqual([
			'@babel/code-frame@7.10.4',
		]);
	});

	it('emits nothing for a block whose version line is unreadable', () => {
		const lock = `express@^4.18.0:
  resolved "https://registry.example.invalid/express/-/express-4.18.2.tgz"
`;
		expect(detectComponents('yarn.lock', lock)).toEqual([]);
	});
});

describe('sbom detectors — regression: yarn Berry yields zero components (#2956)', () => {
	it('parses quoted npm: comma-lists, skips __metadata and workspace blocks', () => {
		const lock = `__metadata:
  version: 8

"demo-app@workspace:.":
  version: 0.0.0
  resolution: "demo-app@workspace:."

"express@npm:^4.18.0, express@npm:^4.18.2":
  version: 4.18.2

"accepts@npm:~1.3.8":
  version: 1.3.8
`;
		expect(setOf(detectComponents('yarn.lock', lock))).toEqual([
			'accepts@1.3.8',
			'express@4.18.2',
		]);
	});

	it('skips patch:, portal:, and link: protocol specs', () => {
		const lock = `"patched-pkg@patch:patched-pkg@npm%3A1.0.0#~/.yarn/patches/x.patch::version=1.0.0":
  version: 1.0.0

"linked-pkg@link:../local-pkg":
  version: 0.0.0

"portaled-pkg@portal:../portal-pkg":
  version: 0.0.0

"registry-pkg@npm:^2.0.0":
  version: 2.1.0
`;
		expect(setOf(detectComponents('yarn.lock', lock))).toEqual([
			'registry-pkg@2.1.0',
		]);
	});
});

describe('sbom detectors — regression: npm lockfile name derivation (#2956)', () => {
	it('keeps scoped entries and names nested entries after the last node_modules segment', () => {
		// Previous code stripped everything from the first '@' (emptying
		// @types/node) and only stripped the first node_modules/ prefix
		// (emitting debug/node_modules/ms).
		const lock = JSON.stringify({
			lockfileVersion: 3,
			packages: {
				'': { name: 'root', version: '1.0.0' },
				'node_modules/@types/node': { version: '20.11.30' },
				'node_modules/debug/node_modules/ms': { version: '2.1.3' },
			},
		});
		expect(setOf(detectComponents('package-lock.json', lock))).toEqual([
			'@types/node@20.11.30',
			'ms@2.1.3',
		]);
	});

	it('passes v1 bare dependencies keys through unchanged', () => {
		const lock = JSON.stringify({
			lockfileVersion: 1,
			dependencies: {
				express: { version: '4.18.2' },
				'@types/node': { version: '18.19.50' },
			},
		});
		expect(setOf(detectComponents('package-lock.json', lock))).toEqual([
			'@types/node@18.19.50',
			'express@4.18.2',
		]);
	});
});

describe('sbom detectors — regression: pnpm v9 lockfile yields zero components (#2956)', () => {
	it('parses slash-less v9 keys and single-quoted scoped keys', () => {
		const lock = `lockfileVersion: '9.0'

packages:

  express@4.18.2:
    resolution: {integrity: sha512-aaa}

  '@types/node@20.11.30':
    resolution: {integrity: sha512-bbb}
`;
		expect(setOf(detectComponents('pnpm-lock.yaml', lock))).toEqual([
			'@types/node@20.11.30',
			'express@4.18.2',
		]);
	});

	it('strips peer-suffixes and keeps v6 leading-slash keys, ignoring nested dependency blocks', () => {
		const lock = `lockfileVersion: '6.0'

packages:

  /@types/node@18.19.50:
    resolution: {integrity: sha512-bbb}

  /accepts@1.3.8(express@4.18.2):
    resolution: {integrity: sha512-ddd}
    dependencies:
      mime-types: 2.1.35
`;
		expect(setOf(detectComponents('pnpm-lock.yaml', lock))).toEqual([
			'@types/node@18.19.50',
			'accepts@1.3.8',
		]);
	});

	it('does not double-count snapshots entries in v9', () => {
		const lock = `lockfileVersion: '9.0'

packages:

  express@4.18.2:
    resolution: {integrity: sha512-aaa}

snapshots:

  express@4.18.2:
    dependencies:
      ms: 2.1.3
`;
		const components = detectComponents('pnpm-lock.yaml', lock);
		expect(components.length).toBe(1);
		expect(setOf(components)).toEqual(['express@4.18.2']);
	});

	it('strips ALL trailing peer-suffix groups (multi-peer keys keep their own version)', () => {
		// Regression (implementation review round 1): stripping exactly one
		// trailing (...) group left `ts-node@10.9.1(@types/node` as the name
		// and the first peer's version `18.11.18)` as the version — a wrong
		// BOM entry where the pre-fix parser was correct.
		const v6 = `packages:

  /ts-node@10.9.1(@types/node@18.11.18)(typescript@4.9.5):
    resolution: {integrity: sha512-aaa}
`;
		expect(setOf(detectComponents('pnpm-lock.yaml', v6))).toEqual([
			'ts-node@10.9.1',
		]);

		const scoped = `packages:

  /@babel/core@7.23.9(@babel/traverse@7.23.9)(semver@7.5.4):
    resolution: {integrity: sha512-bbb}
`;
		expect(setOf(detectComponents('pnpm-lock.yaml', scoped))).toEqual([
			'@babel/core@7.23.9',
		]);

		const v9 = `packages:

  accepts@1.3.8(express@4.18.2)(mime@2.6.0):
    resolution: {integrity: sha512-ccc}
`;
		expect(setOf(detectComponents('pnpm-lock.yaml', v9))).toEqual([
			'accepts@1.3.8',
		]);
	});
});

describe('sbom detectors — regression: NuGet v1 dependencies fallback is dead code (#2956)', () => {
	it('emits bare-ID keys at their resolved versions', () => {
		// Previous code required '/' in every key, which v1 dependencies-only
		// lockfiles (bare NuGet IDs) can never satisfy.
		const lock = JSON.stringify({
			version: 1,
			dependencies: {
				'net8.0': {
					'Newtonsoft.Json': { type: 'Direct', resolved: '13.0.3' },
					'Microsoft.CSharp': { type: 'Transitive', resolved: '4.7.0' },
				},
			},
		});
		expect(setOf(detectComponents('packages.lock.json', lock))).toEqual([
			'Microsoft.CSharp@4.7.0',
			'Newtonsoft.Json@13.0.3',
		]);
	});
});

describe('dedupeSbomComponents — lockfile precedence over manifest (#2956)', () => {
	it('drops the manifest declared-base twin of a lockfile-resolved name', () => {
		const lockfile: SbomComponent[] = [
			{
				name: 'express',
				version: '4.18.2',
				type: 'library',
				purl: 'pkg:npm/express@4.18.2',
			},
		];
		const manifest: SbomComponent[] = [
			{
				name: 'express',
				version: '4.18.0',
				type: 'library',
				purl: 'pkg:npm/express@4.18.0',
			},
		];
		const merged = dedupeSbomComponents(lockfile, manifest);
		expect(merged.filter((c) => c.name === 'express').length).toBe(1);
		expect(merged.filter((c) => c.name === 'express')[0].version).toBe(
			'4.18.2',
		);
	});

	it('collapses exact-purl duplicates to one', () => {
		const dup: SbomComponent = {
			name: 'ms',
			version: '2.1.3',
			type: 'library',
			purl: 'pkg:npm/ms@2.1.3',
		};
		expect(dedupeSbomComponents([dup, { ...dup }], []).length).toBe(1);
	});

	it('falls back to name@version keys when purl is absent', () => {
		const dup: SbomComponent = {
			name: 'ms',
			version: '2.1.3',
			type: 'library',
		};
		expect(dedupeSbomComponents([dup, { ...dup }], []).length).toBe(1);
	});

	it('preserves first-occurrence order', () => {
		const zeta: SbomComponent = {
			name: 'zeta',
			version: '1.0.0',
			type: 'library',
			purl: 'pkg:npm/zeta@1.0.0',
		};
		const alpha: SbomComponent = {
			name: 'alpha',
			version: '1.0.0',
			type: 'library',
			purl: 'pkg:npm/alpha@1.0.0',
		};
		expect(
			dedupeSbomComponents([zeta, alpha, { ...alpha }], []).map((c) => c.name),
		).toEqual(['zeta', 'alpha']);
	});

	it('is safe on empty inputs', () => {
		expect(dedupeSbomComponents([], [])).toEqual([]);
	});
});
