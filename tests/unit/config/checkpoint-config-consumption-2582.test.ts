/**
 * Issue #2582 guardrail — no schema-validated checkpoint config key may ship
 * with zero runtime readers. Every key enumerated from `CheckpointConfigSchema`
 * must appear as a runtime-reader occurrence somewhere under `src/` outside the
 * schema definition file itself. This is the durable, in-repo form of frozen
 * acceptance check C3: the same defect class (inert config key) that left
 * `auto_checkpoint_threshold` and `enabled` unread since #1691 must fail CI if
 * it recurs — including for keys added to the schema later, which enter the
 * contract automatically because the key set is enumerated, not hardcoded.
 *
 * Reader evidence is a source-occurrence proxy (deliberately coarse so it can
 * never be vacuously satisfied by a comment alone when the name is generic):
 *   - `checkpoint?.<key>` / `checkpoint.<key>` qualified access (the
 *     established consumer shape, cf. src/tools/checkpoint.ts), or
 *   - any bare occurrence of a sufficiently specific key name (>= 8 chars with
 *     an underscore — unique enough that any hit is reader evidence).
 * `enabled` is qualified-only: the bare word is ubiquitous in unrelated config
 * surfaces and would make the scan vacuous.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CheckpointConfigSchema } from '../../../src/config/schema.js';

// The schema is a z.preprocess wrapper (ZodPipe in zod 4); walk to the inner
// ZodObject's `.shape` and union `parse({})` keys so a future key without a
// default is still enumerated.
function enumerateCheckpointKeys(schema: unknown): string[] {
	const keys = new Set<string>();
	const visited = new Set<unknown>();
	const queue: unknown[] = [schema];
	while (queue.length > 0) {
		const node = queue.shift();
		if (!node || typeof node !== 'object' || visited.has(node)) continue;
		visited.add(node);
		const shape = (node as { shape?: unknown }).shape;
		if (shape && typeof shape === 'object') {
			for (const key of Object.keys(shape)) keys.add(key);
		}
		for (const accessor of ['out', 'schema', 'innerType', 'in']) {
			const child = (node as Record<string, unknown>)[accessor];
			if (child && typeof child === 'object') queue.push(child);
		}
	}
	try {
		const parsed = (schema as { parse: (input: unknown) => unknown }).parse({});
		if (parsed && typeof parsed === 'object') {
			for (const key of Object.keys(parsed)) keys.add(key);
		}
	} catch {
		// Defaults unavailable (e.g. a future required key); shape walk stands.
	}
	return [...keys];
}

function readerPattern(key: string): RegExp {
	if (key.length >= 8 && key.includes('_')) {
		return new RegExp(`\\b${key}\\b`);
	}
	return new RegExp(
		`checkpoint\\?\\s*\\.\\s*${key}\\b|checkpoint\\s*\\.\\s*${key}\\b`,
	);
}

function collectSourceFiles(
	dir: string,
	schemaFile: string,
	out: string[],
): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'dist' || entry.name === 'node_modules') continue;
			collectSourceFiles(entryPath, schemaFile, out);
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
		if (entry.name.endsWith('.d.ts') || entry.name.includes('.test.')) continue;
		if (path.resolve(entryPath) === schemaFile) continue;
		out.push(entryPath);
	}
}

describe('checkpoint config consumption guardrail (#2582)', () => {
	test('every CheckpointConfigSchema key has at least one runtime reader under src/', () => {
		const repoRoot = path.resolve(__dirname, '../../..');
		const schemaFile = path.join(repoRoot, 'src', 'config', 'schema.ts');
		const keys = enumerateCheckpointKeys(CheckpointConfigSchema);
		expect(keys.length).toBeGreaterThan(0);

		const files: string[] = [];
		collectSourceFiles(path.join(repoRoot, 'src'), schemaFile, files);
		expect(files.length).toBeGreaterThan(0);

		const contents = new Map<string, string>();
		for (const file of files) {
			try {
				contents.set(file, fs.readFileSync(file, 'utf-8'));
			} catch {
				// Unreadable files carry no reader evidence.
			}
		}

		const inertKeys: string[] = [];
		for (const key of keys) {
			const pattern = readerPattern(key);
			const hasReader = [...contents.values()].some((content) =>
				pattern.test(content),
			);
			if (!hasReader) inertKeys.push(key);
		}
		expect(inertKeys).toEqual([]);
	});
});
