import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	type ExpectedStructure,
	extractHostLoop,
	main,
	readBounded,
	runCheck,
} from '../../../scripts/check-host-contract';

const REPO_ROOT = process.cwd();
const FIXTURES = 'tests/fixtures/host';
const readFixture = (name: string): string =>
	fs.readFileSync(path.join(REPO_ROOT, FIXTURES, name), 'utf8');
const CORPUS = JSON.parse(
	readFixture('expected-structure.json'),
) as ExpectedStructure;

const originals = {
	resolveLatestTag: _internals.resolveLatestTag,
	fetchHostSource: _internals.fetchHostSource,
	runGh: _internals.runGh,
	expectedPath: _internals.expectedPath,
};

function restoreInternals(): void {
	_internals.resolveLatestTag = originals.resolveLatestTag;
	_internals.fetchHostSource = originals.fetchHostSource;
	_internals.runGh = originals.runGh;
	_internals.expectedPath = originals.expectedPath;
}

afterEach(restoreInternals);

describe('host-contract check (issue #2902): committed fixtures', () => {
	test('pinned v1.18.3 excerpt is a clean structural match with no textual notice', async () => {
		const outcome = await runCheck({
			source: `${FIXTURES}/message-v2.v1.18.3.excerpt.ts`,
		});
		expect(outcome.exitCode).toBe(0);
		expect(outcome.lines).toContain('result=STRUCTURE_MATCH');
		expect(outcome.lines.some((l) => l.includes('TEXTUAL_DRIFT_ONLY'))).toBe(
			false,
		);
		expect(outcome.lines.some((l) => l.includes('STRUCTURAL_DRIFT'))).toBe(
			false,
		);
	});

	test('real v1.18.33 excerpt: structure matches AND textual-only drift is noticed (exit 0)', async () => {
		const outcome = await runCheck({
			source: `${FIXTURES}/message-v2.v1.18.33.excerpt.ts`,
		});
		expect(outcome.exitCode).toBe(0);
		expect(outcome.lines).toContain('result=STRUCTURE_MATCH');
		expect(outcome.lines).toContain('result=TEXTUAL_DRIFT_ONLY');
		expect(outcome.lines.some((l) => l.includes('STRUCTURAL_DRIFT'))).toBe(
			false,
		);
	});

	test('role-split-else mutant fails with a drift summary naming else (exit 1)', async () => {
		const outcome = await runCheck({
			source: `${FIXTURES}/message-v2.mutant-added-else.ts`,
		});
		expect(outcome.exitCode).toBe(1);
		expect(outcome.lines).toContain('result=STRUCTURAL_DRIFT');
		expect(
			outcome.lines.find(
				(l) => l.startsWith('structural drift:') && l.includes('else'),
			),
		).toBeDefined();
		expect(outcome.lines.some((l) => l.includes('STRUCTURE_MATCH'))).toBe(
			false,
		);
	});

	test('a source without the converter loop is SOURCE_NOT_FOUND, never a pass', async () => {
		const outcome = await runCheck({
			source: `${FIXTURES}/message-v2.no-loop.ts`,
		});
		expect(outcome.exitCode).toBe(1);
		expect(outcome.lines).toContain('result=SOURCE_NOT_FOUND');
	});
});

describe('host-contract check (issue #2902): synthetic in-test mutations', () => {
	// These strings are built in-test and pushed through the SAME extraction
	// API the CLI uses — nothing keys on a committed fixture filename, so a
	// verdict table keyed on --source paths cannot satisfy them.

	const pinned = readFixture('message-v2.v1.18.3.excerpt.ts');

	test('dropping the parts guard changes the structural digest', () => {
		const mutated = pinned.replace(
			'if (msg.parts.length === 0) continue\n',
			'',
		);
		const extraction = extractHostLoop(mutated);
		expect(extraction).not.toBeNull();
		expect(extraction!.statements).not.toContain(
			'parts-guard: parts-length-0 continue',
		);
		expect(extraction!.statements).not.toEqual(CORPUS.statements);
	});

	test('renaming the assistant role literal is structural drift', () => {
		const mutated = pinned.replace(
			'msg.info.role === "assistant"',
			'msg.info.role === "bot"',
		);
		const extraction = extractHostLoop(mutated);
		expect(extraction!.statements).toContain('branch: bot');
		expect(extraction!.statements).not.toContain('branch: assistant');
		expect(extraction!.structuralDigest).not.toBe(CORPUS.structuralDigest);
	});

	test('an else-if INSIDE the user branch stays textual (structure matches, text drifts)', () => {
		const anchor =
			'if (part.type === "text" && !part.ignored && part.text !== "")';
		const mutated = pinned.replace(
			anchor,
			`${anchor} {} else if (part.type === "image") {\n          userMessage.parts.push({ type: "text", text: "img" })\n        }`,
		);
		expect(mutated).not.toBe(pinned);
		const extraction = extractHostLoop(mutated);
		expect(extraction!.statements).toEqual(CORPUS.statements);
		expect(extraction!.structuralDigest).toBe(CORPUS.structuralDigest);
		expect(extraction!.normalizedText).not.toBe(CORPUS.normalizedExcerpt);
	});

	test('a comment/whitespace-only rewrite keeps digest and normalized text stable', () => {
		const mutated = pinned
			.replace(
				'for (const msg of input) {',
				'// synthetic rewrite comment\n   for (const msg of input)   {',
			)
			.replace(
				'if (msg.parts.length === 0) continue',
				'if (msg.parts.length === 0)   continue',
			);
		const extraction = extractHostLoop(mutated);
		expect(extraction!.statements).toEqual(CORPUS.statements);
		expect(extraction!.structuralDigest).toBe(CORPUS.structuralDigest);
		expect(extraction!.normalizedText).toBe(CORPUS.normalizedExcerpt);
	});

	test('a renamed loop variable means the anchor is gone (SOURCE_NOT_FOUND class)', () => {
		const mutated = pinned.replace(
			'for (const msg of input)',
			'for (const m of input)',
		);
		expect(extractHostLoop(mutated)).toBeNull();
	});
});

describe('host-contract check (issue #2902): tag resolution', () => {
	test('default tag resolution flows the resolved (v-prefixed) tag into the fetch', async () => {
		let fetchedTag = '';
		_internals.resolveLatestTag = async () => '9.9.9';
		_internals.fetchHostSource = async (tag: string) => {
			fetchedTag = tag;
			return readFixture('message-v2.v1.18.3.excerpt.ts');
		};
		const outcome = await runCheck({});
		expect(fetchedTag).toBe('v9.9.9');
		expect(outcome.lines[0]).toBe('host-contract: tag=v9.9.9');
		expect(outcome.exitCode).toBe(0);
	});

	test('npm resolution failure exits non-zero — never a silent pass', async () => {
		_internals.resolveLatestTag = async () => '';
		const outcome = await runCheck({});
		expect(outcome.exitCode).toBe(1);
		expect(outcome.lines).toContain('result=SOURCE_NOT_FOUND');
	});

	test('an unfetchable host source (moved/renamed file) exits non-zero', async () => {
		_internals.fetchHostSource = async () => null;
		const outcome = await runCheck({ tag: 'v1.18.33' });
		expect(outcome.exitCode).toBe(1);
		expect(outcome.lines).toContain('result=SOURCE_NOT_FOUND');
	});
});

describe('host-contract check (issue #2902): drift routing', () => {
	const mutantSource = () => readFixture('message-v2.mutant-added-else.ts');
	const calls: string[][] = [];
	const BOT = 'github-actions[bot]';
	const fakeGh =
		(listResult: string | null) =>
		(args: string[]): { ok: boolean; stdout: string; error?: string } => {
			calls.push(args);
			if (listResult === null)
				return { ok: false, stdout: '', error: 'gh exited 1' };
			if (args[1] === 'list') return { ok: true, stdout: listResult };
			return { ok: true, stdout: 'https://example.invalid/i/1' };
		};

	function setup(): void {
		_internals.fetchHostSource = async () => mutantSource();
		// The routing target falls back to GH_REPO when set; pin the env for
		// determinism (the override test sets it explicitly).
		delete process.env.GH_REPO;
	}

	test('creates one tracking issue when none exists', async () => {
		calls.length = 0;
		setup();
		_internals.runGh = fakeGh('[]');
		const outcome = await runCheck({ tag: 'v1.18.33', routeOnDrift: true });
		expect(outcome.exitCode).toBe(1);
		const create = calls.find((c) => c[1] === 'create');
		expect(create).toBeDefined();
		expect(create![create!.indexOf('--title') + 1]).toBe(
			'Host contract drift: message-v2.ts @ v1.18.33',
		);
		expect(calls.filter((c) => c[1] === 'create')).toHaveLength(1);
	});

	test('comments on the existing bot-owned tracking issue instead of duplicating', async () => {
		calls.length = 0;
		setup();
		_internals.runGh = fakeGh(
			JSON.stringify([
				{
					number: 42,
					title: 'Host contract drift: message-v2.ts @ vOLD',
					author: { login: BOT },
				},
			]),
		);
		const outcome = await runCheck({ tag: 'v1.18.33', routeOnDrift: true });
		expect(outcome.exitCode).toBe(1);
		expect(calls.some((c) => c[1] === 'create')).toBe(false);
		const comment = calls.find((c) => c[1] === 'comment');
		expect(comment).toBeDefined();
		expect(comment!.includes('42')).toBe(true);
	});

	test('a human-titled lookalike issue is never adopted (PRR-003)', async () => {
		calls.length = 0;
		setup();
		_internals.runGh = fakeGh(
			JSON.stringify([
				{
					number: 7,
					title: 'Host contract drift: message-v2.ts — retrospective',
					author: { login: 'somehuman' },
				},
			]),
		);
		const outcome = await runCheck({ tag: 'v1.18.33', routeOnDrift: true });
		expect(outcome.exitCode).toBe(1);
		const create = calls.find((c) => c[1] === 'create');
		expect(create).toBeDefined();
		expect(calls.some((c) => c[1] === 'comment')).toBe(false);
	});

	test('the list call fetches author + up to 500 issues (PRR-010)', async () => {
		calls.length = 0;
		setup();
		_internals.runGh = fakeGh('[]');
		await runCheck({ tag: 'v1.18.33', routeOnDrift: true });
		const list = calls.find((c) => c[1] === 'list');
		expect(list).toBeDefined();
		expect(list!.join(' ')).toContain('author');
		expect(list![list!.indexOf('--limit') + 1]).toBe('500');
	});

	test('GH_REPO overrides the routing target when set (Copilot/PRR-017)', async () => {
		calls.length = 0;
		setup();
		process.env.GH_REPO = 'some-fork/opencode-swarm';
		_internals.runGh = fakeGh('[]');
		try {
			await runCheck({ tag: 'v1.18.33', routeOnDrift: true });
		} finally {
			delete process.env.GH_REPO;
		}
		const create = calls.find((c) => c[1] === 'create');
		expect(create![create!.indexOf('--repo') + 1]).toBe(
			'some-fork/opencode-swarm',
		);
	});

	test('gh list failure is fail-closed: ROUTE-FAILED, nothing created', async () => {
		calls.length = 0;
		setup();
		_internals.runGh = fakeGh(null);
		const outcome = await runCheck({ tag: 'v1.18.33', routeOnDrift: true });
		expect(outcome.exitCode).toBe(1);
		expect(
			outcome.lines.some((l) => l.startsWith('host-contract: ROUTE-FAILED')),
		).toBe(true);
		expect(calls.some((c) => c[1] === 'create' || c[1] === 'comment')).toBe(
			false,
		);
	});

	test('dry-run prints the gh command without creating', async () => {
		calls.length = 0;
		setup();
		_internals.runGh = fakeGh('[]');
		const outcome = await runCheck({
			tag: 'v1.18.33',
			routeOnDrift: true,
			dryRun: true,
		});
		expect(outcome.exitCode).toBe(1);
		expect(outcome.lines.some((l) => l.includes('dry-run gh'))).toBe(true);
		expect(calls.some((c) => c[1] === 'create' || c[1] === 'comment')).toBe(
			false,
		);
	});

	test('without --route-on-drift no gh call is made at all', async () => {
		calls.length = 0;
		setup();
		_internals.runGh = fakeGh('[]');
		const outcome = await runCheck({ tag: 'v1.18.33' });
		expect(outcome.exitCode).toBe(1);
		expect(calls).toHaveLength(0);
	});
});

describe('host-contract check (issue #2902): feedback-round hardening', () => {
	let tmpDir: string;
	let tmpCounter = 0;
	function tempCorpusPath(): string {
		if (!tmpDir)
			tmpDir = fs.mkdtempSync(path.join(REPO_ROOT, '.tmp-host-contract-'));
		return path.join(tmpDir, `corpus-${++tmpCounter}.json`);
	}

	afterEach(() => {
		_internals.expectedPath = path.join(
			REPO_ROOT,
			'tests/fixtures/host/expected-structure.json',
		);
		if (tmpDir) {
			fs.rmSync(tmpDir, { recursive: true, force: true });
			tmpDir = '';
		}
	});

	test('mutant diff output names the expected and actual statements (PRR-004 surface)', async () => {
		const outcome = await runCheck({
			source: `${FIXTURES}/message-v2.mutant-added-else.ts`,
		});
		expect(outcome.lines).toContain('--- expected statements');
		expect(outcome.lines).toContain('+++ actual statements');
		expect(outcome.lines).toContain('-else-default: absent');
		expect(outcome.lines).toContain('+else-default: present');
	});

	test('textual-only drift notice carries the refresh command (PRR-008)', async () => {
		const outcome = await runCheck({
			source: `${FIXTURES}/message-v2.v1.18.33.excerpt.ts`,
		});
		expect(
			outcome.lines.some(
				(l) => l.includes('--emit-expected') && l.includes('refresh'),
			),
		).toBe(true);
	});

	test('a swapped-operand parts guard is still structural (PRR-013)', () => {
		const pinned = readFixture('message-v2.v1.18.3.excerpt.ts');
		const mutated = pinned.replace(
			'if (msg.parts.length === 0) continue',
			'if (0 === msg.parts.length) continue',
		);
		const extraction = extractHostLoop(mutated);
		expect(extraction!.statements).toContain(
			'parts-guard: parts-length-0 continue',
		);
		expect(extraction!.statements).toEqual(CORPUS.statements);
	});

	test('a malformed corpus is CORPUS_INVALID, not an opaque crash (PRR-011)', async () => {
		const corpusPath = tempCorpusPath();
		fs.writeFileSync(corpusPath, '{"broken": ', 'utf8');
		_internals.expectedPath = corpusPath;
		const outcome = await runCheck({
			source: `${FIXTURES}/message-v2.v1.18.3.excerpt.ts`,
		});
		expect(outcome.exitCode).toBe(1);
		expect(outcome.lines).toContain('result=CORPUS_INVALID');
		expect(
			outcome.lines.some((l) => l.includes('corpus is not valid JSON')),
		).toBe(true);
	});

	test('a shape-invalid corpus (statements not a string array) is CORPUS_INVALID', async () => {
		const corpusPath = tempCorpusPath();
		fs.writeFileSync(
			corpusPath,
			JSON.stringify({ statements: 'nope', normalizedExcerpt: 'x' }),
			'utf8',
		);
		_internals.expectedPath = corpusPath;
		const outcome = await runCheck({
			source: `${FIXTURES}/message-v2.v1.18.3.excerpt.ts`,
		});
		expect(outcome.lines).toContain('result=CORPUS_INVALID');
		expect(outcome.lines.some((l) => l.includes('statements'))).toBe(true);
	});

	test('readBounded caps by Content-Length and by actual bytes (PRR-014)', async () => {
		const small = new TextEncoder().encode('hello').buffer as ArrayBuffer;
		const over = new TextEncoder().encode('a'.repeat(11)).buffer as ArrayBuffer;
		const mk = (len: string | null, buf: ArrayBuffer) =>
			({
				headers: { get: () => len },
				arrayBuffer: async () => buf,
			}) as unknown as Response;
		expect(await readBounded(mk('4', small), 10)).toBe('hello');
		expect(await readBounded(mk('999', small), 10)).toBeNull();
		expect(await readBounded(mk(null, over), 10)).toBeNull();
		const boom = {
			headers: { get: () => null },
			arrayBuffer: async () => {
				throw new Error('x');
			},
		} as unknown as Response;
		expect(await readBounded(boom, 10)).toBeNull();
	});

	test('main() CLI: mutual exclusion, unknown flags, and emit paths (PRR-004)', async () => {
		expect(await main(['--tag', 'v1', '--source', 'x'])).toBe(2);
		expect(await main(['--bogus'])).toBe(2);
		expect(await main(['--as-tag', 'v2'])).toBe(2);
		expect(await main(['--tag'])).toBe(2);

		const corpusPath = tempCorpusPath();
		_internals.expectedPath = corpusPath;
		expect(
			await main([
				'--emit-expected',
				`${FIXTURES}/message-v2.v1.18.3.excerpt.ts`,
			]),
		).toBe(0);
		const defaultCorpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
		expect(defaultCorpus.pinnedTag).toBe('v1.18.3');
		expect(defaultCorpus.statements).toEqual(CORPUS.statements);

		expect(
			await main([
				'--emit-expected',
				`${FIXTURES}/message-v2.v1.18.33.excerpt.ts`,
				'--as-tag',
				'v1.18.33',
				'--as-commit',
				'deadbeef',
			]),
		).toBe(0);
		const flagged = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
		expect(flagged.pinnedTag).toBe('v1.18.33');
		expect(flagged.pinnedCommit).toBe('deadbeef');

		expect(
			await main(['--emit-expected', `${FIXTURES}/message-v2.no-loop.ts`]),
		).toBe(1);
	});

	test('the real gh spawn path works where gh exists (PRR-004, environment-guarded)', () => {
		if (!Bun.which('gh')) {
			console.log('gh not on PATH; skipping real spawn smoke');
			return;
		}
		const res = _internals.runGh(['--version']);
		expect(res.ok).toBe(true);
		expect(res.stdout.length).toBeGreaterThan(0);
	});
});
