import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
	combineFragments,
	combineRenderedFragments,
	decodeFragmentBytes,
	describeModeError,
	FRONTMATTER_MAX_LINES,
	reconstructPublishedBlockFromWorkspace,
	renderFragmentBody,
	selectEntriesForPublishedBlock,
	upsertReleaseNotesBlock,
} from '../../../scripts/release-notes-fragments.mjs';

const FRONTMATTER_FRAGMENT =
	'---\ntitle: Synthetic probe\nissue: 4242\n---\n\n## What changed\n\n- probe body\n';
const PLAIN_FRAGMENT = '## What changed\n\n- plain body\n';
const CRLF_FRONTMATTER_FRAGMENT =
	'---\r\ntitle: CRLF probe\r\nissue: 4242\r\n---\r\n\r\n## What changed\r\n\r\n- body\r\n';

describe('renderFragmentBody (#2899)', () => {
	test('strips a leading YAML frontmatter block', () => {
		expect(renderFragmentBody(FRONTMATTER_FRAGMENT)).toBe(
			'## What changed\n\n- probe body\n',
		);
	});

	test('strip consumes the blank line after the closing fence (position-independent)', () => {
		// The publish path trims the whole payload (position 1 loses leading
		// whitespace) while inner parts keep theirs — the rendered form must be
		// deterministic either way.
		expect(renderFragmentBody(FRONTMATTER_FRAGMENT)).not.toContain('title:');
		expect(renderFragmentBody(FRONTMATTER_FRAGMENT).startsWith('\n')).toBe(
			false,
		);
	});

	test('strips CRLF frontmatter', () => {
		expect(renderFragmentBody(CRLF_FRONTMATTER_FRAGMENT)).toBe(
			'## What changed\r\n\r\n- body\r\n',
		);
	});

	test('preserves a fragment that legitimately starts with a horizontal rule', () => {
		// No closing fence at all.
		const hrNoClose = '---\n\n## Notes\n\nA separator, not frontmatter.\n';
		expect(renderFragmentBody(hrNoClose)).toBe(hrNoClose);
		// A closing fence exists later, but the lines between are prose — the
		// naive lazy regex would over-strip; the YAML-shape guard must not.
		const hrWithLaterRule =
			'---\n\n## Notes\n\nA separator, not frontmatter.\n\n---\n\nMore\n';
		expect(renderFragmentBody(hrWithLaterRule)).toBe(hrWithLaterRule);
	});

	test('returns plain fragments and non-strings unchanged', () => {
		expect(renderFragmentBody(PLAIN_FRAGMENT)).toBe(PLAIN_FRAGMENT);
		expect(renderFragmentBody('')).toBe('');
		expect(renderFragmentBody(undefined as unknown as string)).toBe('');
	});

	test('refuses an oversized frontmatter-shaped block', () => {
		const lines = [
			'---',
			...Array.from(
				{ length: FRONTMATTER_MAX_LINES + 5 },
				(_, i) => `key${i}: value`,
			),
			'---',
			'\nbody',
		];
		expect(renderFragmentBody(lines.join('\n'))).toBe(lines.join('\n'));
	});

	test('accepts quoted keys and comments inside the fence', () => {
		const quoted = '---\n# comment\n"opencode-swarm": minor\n---\n\nbody\n';
		expect(renderFragmentBody(quoted)).toBe('body\n');
	});
});

describe('combineRenderedFragments (#2899)', () => {
	test('emits frontmatter-free notes with raw ordering parity', () => {
		const entries = [
			{
				prNumber: 2,
				filePath: 'docs/releases/pending/b.md',
				content: FRONTMATTER_FRAGMENT,
			},
			{
				prNumber: 1,
				filePath: 'docs/releases/pending/a.md',
				content: PLAIN_FRAGMENT,
			},
		];
		const rendered = combineRenderedFragments(entries);
		expect(rendered).not.toContain('title:');
		expect(rendered.startsWith('## What changed')).toBe(true);
		// Same separator and ordering as the raw join.
		const raw = combineFragments(entries);
		expect(rendered.split('\n\n---\n\n')).toHaveLength(
			raw.split('\n\n---\n\n').length,
		);
	});

	test('raw combine stays verbatim (oracle join)', () => {
		const entries = [
			{
				prNumber: 1,
				filePath: 'docs/releases/pending/a.md',
				content: FRONTMATTER_FRAGMENT,
			},
		];
		expect(combineFragments(entries).startsWith('---\ntitle:')).toBe(true);
	});
});

describe('oracle tolerates both published forms (#2899)', () => {
	const entries = [
		{
			prNumber: 1,
			filePath: 'docs/releases/pending/a.md',
			content: FRONTMATTER_FRAGMENT,
		},
	];
	const rawBody = upsertReleaseNotesBlock(
		'release-please body',
		combineFragments(entries),
	);
	const renderedBody = upsertReleaseNotesBlock(
		'release-please body',
		combineRenderedFragments(entries),
	);

	test('selectEntriesForPublishedBlock accepts the raw published body', () => {
		const selected = selectEntriesForPublishedBlock(entries, rawBody);
		expect(selected).toHaveLength(1);
		expect(selected?.[0].filePath).toBe('docs/releases/pending/a.md');
	});

	test('selectEntriesForPublishedBlock accepts the rendered published body', () => {
		const selected = selectEntriesForPublishedBlock(entries, renderedBody);
		expect(selected).toHaveLength(1);
		expect(selected?.[0].filePath).toBe('docs/releases/pending/a.md');
	});

	test('non-first-position frontmatter fragment matches in a multi-fragment rendered body', () => {
		const multi = [
			{
				prNumber: 1,
				filePath: 'docs/releases/pending/a.md',
				content: PLAIN_FRAGMENT,
			},
			{
				prNumber: 2,
				filePath: 'docs/releases/pending/b.md',
				content: FRONTMATTER_FRAGMENT,
			},
		];
		const multiRenderedBody = upsertReleaseNotesBlock(
			'body',
			combineRenderedFragments(multi),
		);
		const selected = selectEntriesForPublishedBlock(multi, multiRenderedBody);
		expect(selected).toHaveLength(2);
		expect(selected?.map((e) => e.filePath)).toEqual([
			'docs/releases/pending/a.md',
			'docs/releases/pending/b.md',
		]);
	});

	test('reconstructPublishedBlockFromWorkspace resolves a rendered published body from raw workspace files', () => {
		// Workspace (listFragments/readFragment) injected so no real fs is
		// needed: the workspace carries the RAW fragments while the published
		// body carries the rendered form — reconstruction must still resolve.
		const repoRoot = '/synthetic-repo';
		const options = {
			listFragments: () => [
				{
					relativePath: 'docs/releases/pending/a.md',
					absolute: `${repoRoot}/docs/releases/pending/a.md`,
					regular: true,
					size: FRONTMATTER_FRAGMENT.length,
				},
			],
			readFragment: (_root: string, p: string) =>
				p === 'docs/releases/pending/a.md'
					? { content: FRONTMATTER_FRAGMENT, contentSha256: '0'.repeat(64) }
					: null,
		};
		const resolved = reconstructPublishedBlockFromWorkspace(
			repoRoot,
			renderedBody,
			options,
		);
		expect(resolved).toHaveLength(1);
		expect(resolved[0].filePath).toBe('docs/releases/pending/a.md');
		expect(resolved[0].prNumber).toBeNull();
		expect(resolved[0].order).toBe(0);
	});

	test('idempotency: re-upsert of the rendered combined over the rendered body is a no-op', () => {
		const again = upsertReleaseNotesBlock(
			renderedBody,
			combineRenderedFragments(entries),
		);
		expect(again).toBe(renderedBody);
	});
});

describe('update modes inject the rendered form (#2899 wiring)', () => {
	test('every combine* call site sits in its allowed region (call-site census)', async () => {
		const source = await Bun.file(
			path.join(
				import.meta.dir,
				'../../../scripts/release-notes-fragments.mjs',
			),
		).text();
		const lines = source.split('\n');
		const regionOf = (line: number): string => {
			for (let i = line; i >= 0; i -= 1) {
				const m = /^(?:export )?(?:async )?function ([A-Za-z_][A-Za-z0-9_]*)\(/.exec(
					lines[i] ?? '',
				);
				if (m) return m[1];
			}
			return '<module>';
		};
		const callSites: { name: string; region: string; line: number }[] = [];
		lines.forEach((line, idx) => {
			for (const match of line.matchAll(
				/(?<!function )\b(combineFragments|combineRenderedFragments)\(/g,
			)) {
				callSites.push({
					name: match[1],
					region: regionOf(idx),
					line: idx + 1,
				});
			}
		});
		expect(callSites.length).toBeGreaterThan(0);
		expect(
			callSites.some((site) => site.name === 'combineRenderedFragments'),
		).toBe(true);
		for (const site of callSites) {
			if (site.name === 'combineRenderedFragments') {
				expect(
					site.region === 'modeUpdatePr' ||
						site.region === 'modeUpdateRelease' ||
						site.region === 'publishedBlockMatchesEntries',
					`combineRenderedFragments called outside the two update modes or the oracle rendered arm at line ${site.line} (region ${site.region})`,
				).toBe(true);
			} else {
				expect(
					site.region === 'publishedBlockMatchesEntries' ||
						site.region === 'combineFragments',
					`combineFragments called outside the oracle/definition at line ${site.line} (region ${site.region})`,
				).toBe(true);
			}
		}
	});
});

describe('describeModeError (#2899)', () => {
	test('reduces a decode failure to a one-line ::error:: naming the fragment', () => {
		let thrown: Error | undefined;
		try {
			decodeFragmentBytes(
				new Uint8Array([0xff, 0xfe, 0x00, 0x44]),
				'docs/releases/pending/probe.md',
			);
		} catch (error) {
			thrown = error as Error;
		}
		expect(thrown).toBeInstanceOf(Error);
		const clean = describeModeError(thrown!);
		expect(clean).toBeString();
		expect(clean.startsWith('::error::')).toBe(true);
		expect(clean).toContain('docs/releases/pending/probe.md');
		expect(clean).not.toContain('    at ');
		expect(clean).not.toContain('\n');
		expect(clean).not.toContain('\r');
	});

	test('handles non-error rejections without throwing', () => {
		const clean = describeModeError('boom' as unknown as Error);
		expect(clean).toBe(
			'::error::release-notes-fragments failed with a non-error value',
		);
	});

	test('CLI main() rejection handler is wired through describeModeError', async () => {
		const source = await Bun.file(
			path.join(
				import.meta.dir,
				'../../../scripts/release-notes-fragments.mjs',
			),
		).text();
		const handlerIdx = source.indexOf('main().then(');
		expect(handlerIdx).toBeGreaterThan(-1);
		expect(source.slice(handlerIdx)).toContain('describeModeError');
	});
});

describe('review follow-up hardening (#2899 swarm-pr-review)', () => {
	test('describeModeError skips leading blank lines and never emits a bare ::error::', () => {
		expect(describeModeError(new Error('   \n\nreal content\nsecond'))).toBe(
			'::error::real content',
		);
		expect(describeModeError(new Error('\r\nreal content'))).toBe(
			'::error::real content',
		);
	});

	test('describeModeError does not double-prefix an already-annotated message', () => {
		expect(describeModeError(new Error('::error::fragment is bad'))).toBe(
			'::error::fragment is bad',
		);
	});

	test('rendered combine omits empty parts; raw combine keeps them', () => {
		const real = {
			prNumber: 1,
			filePath: 'docs/releases/pending/a.md',
			content: '## A\n',
		};
		const empty = {
			prNumber: 2,
			filePath: 'docs/releases/pending/b.md',
			content: '',
		};
		expect(combineRenderedFragments([real, empty])).toBe('## A');
		expect(combineFragments([real, empty])).toBe('## A\n\n---\n\n');
		const frontmatterOnly = {
			prNumber: 3,
			filePath: 'docs/releases/pending/c.md',
			content: '---\ntitle: only\n---\n',
		};
		expect(combineRenderedFragments([real, frontmatterOnly])).toBe('## A');
	});

	test('upsert over a pre-existing RAW block rewrites it to the rendered form, then converges', () => {
		const entries = [
			{
				prNumber: 1,
				filePath: 'docs/releases/pending/a.md',
				content: FRONTMATTER_FRAGMENT,
			},
		];
		const rawBody = upsertReleaseNotesBlock('base', combineFragments(entries));
		const rendered = combineRenderedFragments(entries);
		const first = upsertReleaseNotesBlock(rawBody, rendered);
		expect(first).not.toBe(rawBody);
		expect(first).toContain('## What changed');
		expect(first).not.toContain('title:');
		const second = upsertReleaseNotesBlock(first, rendered);
		expect(second).toBe(first);
	});

	test('CRLF frontmatter fragment resolves at position 2 of a multi-fragment body', () => {
		const multi = [
			{
				prNumber: 1,
				filePath: 'docs/releases/pending/a.md',
				content: PLAIN_FRAGMENT,
			},
			{
				prNumber: 2,
				filePath: 'docs/releases/pending/b.md',
				content: CRLF_FRONTMATTER_FRAGMENT,
			},
		];
		const body = upsertReleaseNotesBlock(
			'body',
			combineRenderedFragments(multi),
		);
		expect(body.includes('\r')).toBe(true);
		const selected = selectEntriesForPublishedBlock(multi, body);
		expect(selected?.map((e) => e.filePath)).toEqual([
			'docs/releases/pending/a.md',
			'docs/releases/pending/b.md',
		]);
	});

	test('mixed raw+rendered parts in one published body fail closed (cleanup refuses)', () => {
		const contentA = '---\ntitle: A\n---\n\n## A\n';
		const contentB = '---\ntitle: B\n---\n\n## B\n';
		const entries = [
			{
				prNumber: 1,
				filePath: 'docs/releases/pending/a.md',
				content: contentA,
			},
			{
				prNumber: 2,
				filePath: 'docs/releases/pending/b.md',
				content: contentB,
			},
		];
		// part 1 published in raw form, part 2 in rendered form
		const body = upsertReleaseNotesBlock(
			'body',
			`${contentA.replace(/\s+$/, '')}\n\n---\n\n## B`,
		);
		expect(selectEntriesForPublishedBlock(entries, body)).toBeNull();
	});

	test('renderFragmentBody refuses unusual YAML shapes (documented fail-closed leak)', () => {
		const tabIndented = '---\n\ttitle: foo\n---\nbody\n';
		expect(renderFragmentBody(tabIndented)).toBe(tabIndented);
		const blockScalar = '---\ndesc: |\n  literal block\n---\nbody\n';
		expect(renderFragmentBody(blockScalar)).toBe(blockScalar);
	});
});
