import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { COMMAND_REGISTRY } from '../../../src/commands/registry.js';

/**
 * Phase 4.2 wiring ratchet (issue #2503): the governed HarnessOpt capstone
 * must stay reachable from its registered production surfaces. Removing any
 * surface without updating this ratchet is the "capability described but not
 * executable" defect this issue exists to close.
 */
const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..');

describe('harness-opt production wiring ratchet', () => {
	test('the command family is registered with runnable handlers', () => {
		for (const key of [
			'harness-opt',
			'harness-opt plan',
			'harness-opt run',
			'harness-opt compare',
			'harness-opt status',
			'harness-opt stop',
			'harness-opt history',
		]) {
			const entry = COMMAND_REGISTRY[key as keyof typeof COMMAND_REGISTRY] as
				| { handler?: unknown; toolPolicy?: string }
				| undefined;
			expect(entry, `${key} must stay registered`).toBeDefined();
			expect(typeof entry?.handler, `${key} must have a handler`).toBe(
				'function',
			);
			expect(entry?.toolPolicy, `${key} must declare a toolPolicy`).toEqual(
				expect.any(String),
			);
		}
	});

	test('the TUI shortcut is registered in the plugin command surface', () => {
		const indexSource = readFileSync(
			path.join(REPO_ROOT, 'src', 'index.ts'),
			'utf8',
		);
		expect(indexSource).toContain("'swarm-harness-opt'");
		expect(indexSource).toContain('/swarm harness-opt $ARGUMENTS');
	});

	test('the five service modules exist', () => {
		for (const module of [
			'controller.ts',
			'comparative.ts',
			'oracle.ts',
			'lineage.ts',
			'manifest.ts',
		]) {
			expect(() =>
				readFileSync(
					path.join(REPO_ROOT, 'src', 'services', 'harness-optimizer', module),
					'utf8',
				),
			).not.toThrow();
		}
	});

	test('docs/commands.md documents the family (generated surface)', () => {
		const docs = readFileSync(
			path.join(REPO_ROOT, 'docs', 'commands.md'),
			'utf8',
		);
		expect(docs).toContain('### `/swarm harness-opt`');
	});

	test('the config block is declared in the schema and consumed by the doctor', () => {
		const schema = readFileSync(
			path.join(REPO_ROOT, 'src', 'config', 'schema.ts'),
			'utf8',
		);
		expect(schema).toContain('HarnessOptConfigSchema');
		expect(schema).toContain('harness_opt:');
		const doctor = readFileSync(
			path.join(REPO_ROOT, 'src', 'services', 'config-doctor.ts'),
			'utf8',
		);
		expect(doctor).toContain("case 'harness_opt':");
	});
});
