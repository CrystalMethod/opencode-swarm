/**
 * #2672: knowledge-injector context-cache invalidation on instruction-set
 * (payload-input) changes. Real hook + real file I/O on hermetic temp
 * `.swarm/` roots; receipt/search seams stubbed through `_internals`
 * (the sanctioned DI seam).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
	createKnowledgeInjectorHook,
	_internals as injectorInternals,
} from '../../../src/hooks/knowledge-injector.js';
import {
	appendKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store.js';
import type {
	KnowledgeConfig,
	MessageWithParts,
	SwarmKnowledgeEntry,
} from '../../../src/hooks/knowledge-types.js';
import { swarmState } from '../../../src/state.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const SESSION_ID = 'fingerprint-2672-session';
let restoreSearch: (() => void) | null = null;

function stubSearchZeroResults(): void {
	const original = injectorInternals.searchKnowledge;
	injectorInternals.searchKnowledge = (async () => ({
		results: [],
		trace_id: 'fingerprint-test-trace',
	})) as unknown as typeof injectorInternals.searchKnowledge;
	restoreSearch = () => {
		injectorInternals.searchKnowledge = original;
	};
}

afterEach(() => {
	restoreSearch?.();
	restoreSearch = null;
	swarmState.activeAgent.clear();
});

function makeConfig(): KnowledgeConfig {
	return {
		enabled: true,
		swarm_max_entries: 100,
		hive_max_entries: 200,
		auto_promote_days: 90,
		max_inject_count: 5,
		dedup_threshold: 0.6,
		scope_filter: ['global'],
		hive_enabled: false,
		rejected_max_entries: 20,
		validation_enabled: true,
		evergreen_confidence: 0.9,
		evergreen_utility: 0.8,
		low_utility_threshold: 0.3,
		min_retrievals_for_utility: 3,
		schema_version: 1,
		inject_char_budget: 4000,
	} as KnowledgeConfig;
}

function makeMessages(): { messages: MessageWithParts[] } {
	swarmState.activeAgent.set(SESSION_ID, 'architect');
	return {
		messages: [
			{
				info: { role: 'system', agent: 'architect', sessionID: SESSION_ID },
				parts: [{ type: 'text', text: 'System prompt' }],
			},
			{
				info: { role: 'user', sessionID: SESSION_ID },
				parts: [{ type: 'text', text: 'continue the current task' }],
			},
		],
	};
}

function injectedText(output: { messages: MessageWithParts[] }): string {
	return output.messages
		.filter((m) =>
			m.parts?.some((p) => p.text?.includes('[[KNOWLEDGE-INJECTED]]')),
		)
		.map((m) => m.parts?.map((p) => p.text ?? '').join('') ?? '')
		.join('\n');
}

function makeProject(): string {
	const dir = canonicalMkdtemp('fingerprint-2672-');
	mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	return dir;
}

/** One established entry so the full assembly path runs (run-memory and
 * rejected-lesson inputs are only embedded when entries exist). */
async function seedStoreEntry(dir: string): Promise<void> {
	const entry = {
		id: 'fingerprint-entry-1',
		tier: 'swarm',
		lesson: 'Stable seeded directive lesson',
		category: 'process',
		tags: ['ci'],
		scope: 'global',
		confidence: 0.85,
		status: 'established',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 1,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		project_name: 'fingerprint-test',
		directive_priority: 'high',
	} as SwarmKnowledgeEntry;
	await appendKnowledge(resolveSwarmKnowledgePath(dir), entry);
}

describe('instruction cache invalidates on instruction-set change (#2672)', () => {
	it('re-serves the cache when the instruction set is unchanged', async () => {
		stubSearchZeroResults();
		const dir = makeProject();
		try {
			writeFileSync(
				path.join(dir, '.swarm', 'curator-briefing.md'),
				'BRIEFING-stable content',
				'utf8',
			);
			const hook = createKnowledgeInjectorHook(dir, makeConfig());

			const out1 = makeMessages();
			await hook({}, out1);
			expect(injectedText(out1)).toContain('BRIEFING-stable');

			// Identical context, unchanged inputs: the cache still serves
			// (compaction re-injection preserved).
			const out2 = makeMessages();
			await hook({}, out2);
			expect(injectedText(out2)).toContain('BRIEFING-stable');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('regenerates when the curator briefing changes', async () => {
		stubSearchZeroResults();
		const dir = makeProject();
		try {
			const briefingPath = path.join(dir, '.swarm', 'curator-briefing.md');
			writeFileSync(briefingPath, 'BRIEFING-v1 original', 'utf8');
			const hook = createKnowledgeInjectorHook(dir, makeConfig());

			const out1 = makeMessages();
			await hook({}, out1);
			expect(injectedText(out1)).toContain('BRIEFING-v1');

			writeFileSync(briefingPath, 'BRIEFING-v2 updated', 'utf8');

			const out2 = makeMessages();
			await hook({}, out2);
			const text2 = injectedText(out2);
			expect(text2).toContain('BRIEFING-v2');
			expect(text2).not.toContain('BRIEFING-v1');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('regenerates when the run-memory summary changes', async () => {
		const dir = makeProject();
		try {
			await seedStoreEntry(dir);
			const runMemoryPath = path.join(dir, '.swarm', 'run-memory.jsonl');
			// summarizeTask renders failures (outcome fail/retry) with their
			// failureReason; the reason is the discriminating payload content.
			const entry = (reason: string) =>
				`${JSON.stringify({
					timestamp: '2026-01-01T00:00:00.000Z',
					taskId: '1.1',
					taskFingerprint: 'abcd1234',
					agent: 'coder',
					outcome: 'fail',
					attemptNumber: 1,
					failureReason: reason,
				})}
`;
			writeFileSync(runMemoryPath, entry('REASON-v1'), 'utf8');
			const hook = createKnowledgeInjectorHook(dir, makeConfig());

			const out1 = makeMessages();
			await hook({}, out1);
			const text1 = injectedText(out1);
			expect(text1).toContain('Stable seeded directive lesson');
			expect(text1).toContain('REASON-v1');

			writeFileSync(runMemoryPath, entry('REASON-v2'), 'utf8');

			const out2 = makeMessages();
			await hook({}, out2);
			const text2 = injectedText(out2);
			expect(text2).toContain('REASON-v2');
			expect(text2).not.toContain('REASON-v1');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('regenerates when rejected lessons change', async () => {
		const dir = makeProject();
		try {
			await seedStoreEntry(dir);
			const rejectedPath = path.join(dir, '.swarm', 'knowledge-rejected.jsonl');
			const rejected = (lesson: string) =>
				`${JSON.stringify({
					lesson,
					rejection_reason: 'not actionable',
					recorded_at: '2026-01-01T00:00:00.000Z',
				})}
`;
			writeFileSync(rejectedPath, rejected('REJECTED-v1'), 'utf8');
			const hook = createKnowledgeInjectorHook(dir, makeConfig());

			const out1 = makeMessages();
			await hook({}, out1);
			const text1 = injectedText(out1);
			expect(text1).toContain('Stable seeded directive lesson');
			expect(text1).toContain('REJECTED-v1');

			writeFileSync(rejectedPath, rejected('REJECTED-v2'), 'utf8');

			const out2 = makeMessages();
			await hook({}, out2);
			const text2 = injectedText(out2);
			expect(text2).toContain('REJECTED-v2');
			expect(text2).not.toContain('REJECTED-v1');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
