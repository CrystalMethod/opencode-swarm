/**
 * Issue #2946: Check 9 (destructive-command registry enumeration) unit tests.
 *
 * Green on the PR tree; RED on fixture registries that introduce an
 * unlisted destructive key, a malformed exception line, or a renamed seed
 * key. Uses synthetic fixture trees under canonicalMkdtemp — the real repo
 * is only read for the green-path case.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkDestructiveCommandRegistry } from '../../../scripts/check-invariants';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const fixtureDirs: string[] = [];

const NUKER_SOURCE = [
	'export async function handleNukerCommand(): Promise<string> {',
	'\treturn "boom";',
	'}',
	'',
].join('\n');

function fixtureRepo(files: Record<string, string>): string {
	const root = canonicalMkdtemp('check9-fixture-');
	fixtureDirs.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const target = path.join(root, ...rel.split('/'));
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	}
	return root;
}

const REAL_REGISTRY_ENTRY = `
	nuker: {
		handler: (ctx) => handleNukerCommand(ctx.directory, ctx.args),
		description: 'DELETES everything in the workspace without mercy',
		details: 'purges all files immediately',
		args: '<path>',
		category: 'utility',
		toolPolicy: 'restricted',
	},
`;

function registryWith(extraEntries: string): string {
	return `import { handleNukerCommand } from './nuker.js';
export const COMMAND_REGISTRY = {
${extraEntries}
} as const;
`;
}

afterEach(() => {
	while (fixtureDirs.length > 0) {
		const dir = fixtureDirs.pop() as string;
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
});

describe('Check 9 — destructive registry enumeration (#2946)', () => {
	test('green on the PR tree, with the exception count printed', () => {
		const repoRoot = path.resolve(import.meta.dir, '../../../');
		const result = checkDestructiveCommandRegistry(repoRoot);
		expect(result.violations).toBe(0);
		const summary = result.messages[result.messages.length - 1];
		expect(summary).toMatch(
			/Destructive registry enumeration: \d+ command key\(s\), \d+ exception line\(s\) in use\./,
		);
	});

	test('RED: an unlisted destructive key without markers fails', () => {
		const root = fixtureRepo({
			'src/commands/registry.ts': registryWith(REAL_REGISTRY_ENTRY),
			'src/commands/nuker.ts':
				'export async function handleNukerCommand(): Promise<string> {\n\treturn "boom";\n}\n',
			'src/tools/tool-metadata.ts':
				'export const TOOL_METADATA = {\n\tinnocent: {\n\t\tdescription: "reads things",\n\t\tagents: [],\n\t},\n} as const;\n',
			'scripts/destructive-command-exceptions.txt': '# no exceptions\n',
		});
		const result = checkDestructiveCommandRegistry(root);
		expect(result.violations).toBeGreaterThan(0);
		expect(
			result.messages.some(
				(m) => m.includes("'nuker'") && m.includes('two-step'),
			),
		).toBe(true);
	});

	test('RED: an exception line missing owner or reason fails', () => {
		const root = fixtureRepo({
			'src/commands/registry.ts': registryWith(REAL_REGISTRY_ENTRY),
			'src/commands/nuker.ts':
				'export async function handleNukerCommand(): Promise<string> {\n\treturn "boom";\n}\n',
			'src/tools/tool-metadata.ts':
				'export const TOOL_METADATA = {} as const;\n',
			'scripts/destructive-command-exceptions.txt':
				'nuker | | because I said so\n',
		});
		const result = checkDestructiveCommandRegistry(root);
		expect(
			result.messages.some((m) => m.includes('malformed exception line')),
		).toBe(true);
		expect(result.violations).toBeGreaterThan(0);
	});

	test('RED: renaming a seed key out of the registry fails', () => {
		const root = fixtureRepo({
			// 'rollback' (a seed key) is absent on purpose.
			'src/commands/registry.ts': registryWith(''),
			'src/tools/tool-metadata.ts':
				'export const TOOL_METADATA = {} as const;\n',
			'scripts/destructive-command-exceptions.txt': '# none\n',
		});
		const result = checkDestructiveCommandRegistry(root);
		expect(
			result.messages.some(
				(m) => m.includes("seed key 'rollback'") && m.includes('missing'),
			),
		).toBe(true);
		expect(result.violations).toBeGreaterThan(0);
	});

	test('RED: an exception for a key outside the enumerated set is stale', () => {
		const root = fixtureRepo({
			'src/commands/registry.ts': registryWith(REAL_REGISTRY_ENTRY),
			'src/commands/nuker.ts': NUKER_SOURCE,
			'src/tools/tool-metadata.ts':
				'export const TOOL_METADATA = {} as const;\n',
			'scripts/destructive-command-exceptions.txt':
				'nuker | fixtures | synthetic fixture entry\nghost-key | fixtures | line for a key nothing enumerates\n',
		});
		const result = checkDestructiveCommandRegistry(root);
		expect(
			result.messages.some((m) =>
				m.includes("stale exception for 'ghost-key'"),
			),
		).toBe(true);
		expect(result.violations).toBeGreaterThan(0);
	});

	test('a multiword tool with a HYPHENATED source resolves and passes via adoption (review finding 2)', () => {
		const root = fixtureRepo({
			'src/commands/registry.ts': registryWith(''),
			'src/tools/tool-metadata.ts':
				'export const TOOL_METADATA = {\n\ttool_purge: {\n\tdescription: "purges things",\n\tagents: [],\n\t},\n} as const;\n',
			'src/tools/tool-purge.ts':
				'import { consumeConfirmToken } from "../commands/destructive-purge.js";\nexport const toolPurge = { run: () => consumeConfirmToken("a", "b", "c", {}) };\n',
			'scripts/destructive-command-exceptions.txt': '# none\n',
		});
		const result = checkDestructiveCommandRegistry(root);
		expect(
			result.messages.some(
				(m) => m.includes("tool 'tool_purge'") && m.includes('two-step'),
			),
		).toBe(false);
	});

	test('a listed exception with owner and reason covers its key', () => {
		const root = fixtureRepo({
			'src/commands/registry.ts': registryWith(REAL_REGISTRY_ENTRY),
			'src/commands/nuker.ts':
				'export async function handleNukerCommand(): Promise<string> {\n\treturn "boom";\n}\n',
			'src/tools/tool-metadata.ts':
				'export const TOOL_METADATA = {} as const;\n',
			'scripts/destructive-command-exceptions.txt':
				'nuker | fixtures | synthetic fixture entry used to prove the exception mechanism\n',
		});
		const result = checkDestructiveCommandRegistry(root);
		// Only the seed-key-missing violations remain (the fixture registry
		// intentionally contains no real seed keys); 'nuker' itself passes.
		expect(
			result.messages.some(
				(m) => m.includes("'nuker'") && m.includes('two-step'),
			),
		).toBe(false);
	});
});
