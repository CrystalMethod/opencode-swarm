/**
 * #3169 Phase 3 — eager-registry eviction semantics (companion to
 * session-client-lane-3169.test.ts; split for the FR-006 500-line cap).
 *
 * The shim keeps placeholders and eager lane records in ONE bounded FIFO
 * registry (cap 64). Placeholder residue is intentionally never pruned, so a
 * LIVE eager record can be evicted after 64 later insertions of ANY kind. These
 * tests pin the three facts that disclosure depends on:
 *  - the cap's LOWER bound: 63 live records all survive (so the cap is 64, not
 *    merely "≤65" — a shrunken cap keeps every eviction test green otherwise);
 *  - interleaved eviction: 1 eager + 64 placeholder insertions evicts the eager
 *    record, and its next prompt takes the DIRECT path (no switchModel, no new
 *    context hook) while `get` stops overlaying parentID — the two disclosed
 *    degradations;
 *  - eager-only eviction: of 65 eager records, the oldest loses the full
 *    treatment and the newest keeps it.
 *
 * bun:test, fakes only (no mock.module); every temp path via canonicalMkdtemp.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	clearV2SessionClientState,
	createV2SessionClient,
} from '../../../../src/host/v2/session-client';
import type { V2PluginContext } from '../../../../src/host/v2/types';
import { resetSwarmState } from '../../../../src/state';

const PARENT_DIR = '/proj/root';
const LANE_DIR = '/proj/root/.swarm/worktrees/lane-registry';

interface LaneClient {
	session: {
		create: (args: {
			body?: { parentID?: string; title?: string };
			query: { directory: string };
		}) => Promise<{
			data: { id: string } | null;
			error?: { message?: string };
		}>;
		prompt: (args: {
			path: { id: string };
			body: Record<string, unknown>;
		}) => Promise<{ data: { parts: Array<{ text: string }> } | null }>;
		get: (args: { path: { id: string } }) => Promise<{ data: unknown }>;
	};
}

function makeFakeSessionDomain() {
	const calls: Array<{ op: string; arg: unknown }> = [];
	let next = 0;
	return {
		calls,
		async hook(name: string, callback: (event: unknown) => Promise<void>) {
			calls.push({ op: `hook:${name}`, arg: undefined });
			return { dispose: async () => {} };
		},
		async create(input: { location?: { directory: string } }) {
			calls.push({ op: 'create', arg: input });
			next += 1;
			return {
				id: `ses_real_${next}`,
				location: { directory: input.location?.directory ?? PARENT_DIR },
			};
		},
		async get({ sessionID }: { sessionID: string }) {
			calls.push({ op: 'get', arg: sessionID });
			if (sessionID === 'ses_parent') {
				return { id: sessionID, location: { directory: PARENT_DIR } };
			}
			return { id: sessionID };
		},
		async remove() {
			calls.push({ op: 'remove', arg: undefined });
		},
		async prompt(input: unknown) {
			calls.push({ op: 'prompt', arg: input });
			return {};
		},
		async wait(input: unknown) {
			calls.push({ op: 'wait', arg: input });
		},
		async context() {
			calls.push({ op: 'context', arg: undefined });
			return [
				{ role: 'user', text: 'prompt' },
				{ role: 'assistant', text: 'lane reply' },
				{ type: 'idle', outcome: 'succeeded' },
			];
		},
		async interrupt(input: unknown) {
			calls.push({ op: 'interrupt', arg: input });
		},
		async switchAgent(input: unknown) {
			calls.push({ op: 'switchAgent', arg: input });
		},
		async switchModel(input: unknown) {
			calls.push({ op: 'switchModel', arg: input });
		},
	};
}

describe('eager-registry eviction semantics (#3169 Phase 3)', () => {
	let client: LaneClient;
	let fake: ReturnType<typeof makeFakeSessionDomain>;

	beforeEach(() => {
		resetSwarmState();
		clearV2SessionClientState();
		fake = makeFakeSessionDomain();
		const registration = { dispose: async () => {} };
		client = createV2SessionClient({
			app: { name: 'opencode', version: 'test', channel: 'test' },
			location: {
				directory: PARENT_DIR,
				workspaceID: 'w',
				project: { id: 'p', directory: PARENT_DIR, canonical: PARENT_DIR },
			},
			options: {},
			tool: {
				transform: async () => registration,
				hook: async () => registration,
			},
			agent: { transform: async () => registration },
			command: { transform: async () => registration },
			session: fake,
			event: { subscribe: () => (async function* () {})() },
		} as never as V2PluginContext) as unknown as LaneClient;
	});

	afterEach(() => {
		clearV2SessionClientState();
		resetSwarmState();
	});

	test('cap bound: 63 live records all survive (the cap is 64, not lower)', async () => {
		const first = await client.session.create({
			body: { parentID: 'ses_parent' },
			query: { directory: LANE_DIR },
		});
		for (let i = 0; i < 62; i += 1) {
			await client.session.create({
				body: { title: `lane ${i}` },
				query: { directory: PARENT_DIR },
			});
		}
		// The eager record is still resident, so the overlay still applies.
		const info = await client.session.get({ path: { id: first.data!.id } });
		expect((info.data as { parentID?: string }).parentID).toBe('ses_parent');
	});

	test('interleaved eviction: 64 placeholder insertions evict a live eager record — both degradations', async () => {
		const eager = await client.session.create({
			body: { parentID: 'ses_parent' },
			query: { directory: LANE_DIR },
		});
		for (let i = 0; i < 64; i += 1) {
			await client.session.create({
				body: { title: `residue ${i}` },
				query: { directory: PARENT_DIR },
			});
		}
		// Degradation 1 — the prompt loses the full treatment (no switchModel, no
		// context hook), i.e. the single read-only enforcement layer is gone.
		await client.session.prompt({
			path: { id: eager.data!.id },
			body: {
				model: { providerID: 'p', modelID: 'm' },
				parts: [{ type: 'text', text: 'late' }],
			},
		});
		expect(fake.calls.some((c) => c.op === 'switchModel')).toBe(false);
		// Degradation 1 (second half) — the context hook is NOT re-registered
		// either; this is the half that would survive a switchModel-only revert.
		expect(fake.calls.some((c) => c.op === 'hook:context')).toBe(false);
		// The residue really is PLACEHOLDER records (they mint ids without any
		// host create — the fake records exactly one host create, the eager one),
		// so the eviction driver is the shared FIFO cap rather than host traffic.
		const residueId = await client.session.create({
			body: { title: 'shape probe' },
			query: { directory: PARENT_DIR },
		});
		expect(residueId.data?.id).toMatch(/^v2shim-/);
		expect(fake.calls.filter((c) => c.op === 'create')).toHaveLength(1);
		// Degradation 2 — the parentID overlay no longer applies.
		const info = await client.session.get({ path: { id: eager.data!.id } });
		expect((info.data as { parentID?: string }).parentID).toBeUndefined();
	});

	test('eager-only eviction: of 65 eager records, the oldest loses treatment and the newest keeps it', async () => {
		const ids: string[] = [];
		for (let i = 0; i < 65; i += 1) {
			const r = await client.session.create({
				body: { parentID: 'ses_parent', title: `lane ${i}` },
				query: { directory: LANE_DIR },
			});
			ids.push(r.data!.id);
		}
		await client.session.prompt({
			path: { id: ids[0] },
			body: {
				model: { providerID: 'p', modelID: 'm' },
				parts: [{ type: 'text', text: 'evicted' }],
			},
		});
		expect(fake.calls.some((c) => c.op === 'switchModel')).toBe(false);
		await client.session.prompt({
			path: { id: ids[64] },
			body: {
				model: { providerID: 'p', modelID: 'm' },
				parts: [{ type: 'text', text: 'resident' }],
			},
		});
		expect(fake.calls.some((c) => c.op === 'switchModel')).toBe(true);
	});
});
