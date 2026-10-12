/**
 * Lockfile parser truth matrix (issue #2956).
 *
 * One describe per checked-in redacted fixture under fixtures/lockfiles/.
 * Each test runs the REAL detectComponents against the fixture and asserts
 * EXACT set equality of name@version plus the exact component count — set
 * equality (not toBeGreaterThan(0), not toContain) is what makes any dropped
 * or double-counted component class fail this suite.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { detectComponents } from '../../../src/sbom/detectors/index';

const FIXTURES_DIR = path.join(import.meta.dir, 'fixtures', 'lockfiles');

interface MatrixCase {
	fixture: string;
	fileName: string;
	expected: string[];
	/** Unscoped representative purls asserted literally (scoped purl encoding
	 * is pre-existing behavior outside this issue's scope). */
	representativePurls: string[];
}

const cases: MatrixCase[] = [
	{
		fixture: 'yarn-classic.lock',
		fileName: 'yarn.lock',
		expected: [
			'@babel/code-frame@7.10.4',
			'@babel/core@7.23.9',
			'chalk@2.4.2',
			'express@4.18.2',
			'lodash@4.17.21',
		],
		representativePurls: ['pkg:npm/express@4.18.2', 'pkg:npm/chalk@2.4.2'],
	},
	{
		fixture: 'yarn-berry.lock',
		fileName: 'yarn.lock',
		expected: ['abbrev@2.0.0', 'accepts@1.3.8', 'express@4.18.2'],
		representativePurls: ['pkg:npm/express@4.18.2', 'pkg:npm/abbrev@2.0.0'],
	},
	{
		fixture: 'npm-lock-v3.json',
		fileName: 'package-lock.json',
		expected: ['@types/node@20.11.30', 'express@4.18.2', 'ms@2.1.3'],
		representativePurls: ['pkg:npm/express@4.18.2', 'pkg:npm/ms@2.1.3'],
	},
	{
		fixture: 'pnpm-v6.lock',
		fileName: 'pnpm-lock.yaml',
		expected: [
			'@types/node@18.19.50',
			'accepts@1.3.8',
			'express@4.18.2',
			'ms@2.1.3',
			'ts-node@10.9.1',
		],
		representativePurls: ['pkg:npm/express@4.18.2', 'pkg:npm/ms@2.1.3'],
	},
	{
		fixture: 'pnpm-v9.lock',
		fileName: 'pnpm-lock.yaml',
		expected: ['@types/node@20.11.30', 'express@4.18.2', 'ms@2.1.3'],
		representativePurls: ['pkg:npm/express@4.18.2'],
	},
	{
		fixture: 'nuget-packages-v1.json',
		fileName: 'packages.lock.json',
		expected: ['Microsoft.CSharp@4.7.0', 'Newtonsoft.Json@13.0.3'],
		representativePurls: [
			'pkg:nuget/Newtonsoft.Json@13.0.3',
			'pkg:nuget/Microsoft.CSharp@4.7.0',
		],
	},
];

describe('lockfile parser truth matrix (#2956)', () => {
	for (const matrixCase of cases) {
		describe(matrixCase.fixture, () => {
			const content = readFileSync(
				path.join(FIXTURES_DIR, matrixCase.fixture),
				'utf-8',
			);
			const components = detectComponents(matrixCase.fileName, content);
			const observed = components.map((c) => `${c.name}@${c.version}`);

			test('yields exactly the expected component set', () => {
				expect(new Set(observed)).toEqual(new Set(matrixCase.expected));
			});

			test('emits each component exactly once (no double-count)', () => {
				expect(observed.length).toBe(new Set(observed).size);
				expect(observed.length).toBe(matrixCase.expected.length);
			});

			test('every emitted name is a bare package name', () => {
				expect(components.every((c) => !c.name.includes('node_modules'))).toBe(
					true,
				);
			});

			test('carries literal purls for unscoped representatives', () => {
				for (const purl of matrixCase.representativePurls) {
					expect(components.some((c) => c.purl === purl)).toBe(true);
				}
			});
		});
	}
});
