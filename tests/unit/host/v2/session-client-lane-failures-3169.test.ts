/**
 * #3169 Phase 3 — the eager-arm FAILURE branches (companion suite; split for
 * the FR-006 500-line cap alongside session-client-lane-3169.test.ts and
 * session-client-lane-registry-3169.test.ts).
 *
 * Every test here pins a leg whose ABSENCE would leave the whole suite green
 * after reverting the corresponding hardening — i.e. these discriminate the
 * fixes from their reverts:
 *  - a host that REJECTS the eager create resolves to the typed `{data,error}`
 *    envelope (PRR-006) instead of rejecting;
 *  - a placement mismatch whose compensation `remove` FAILS still surfaces the
 *    session id and `cleanupFailed` (PRR-010), and a long host-reported path is
 *    truncated in the message (PRR-011);
 *  - a delete whose `remove` FAILS keeps the eager record (so the overlay and
 *    teardown addressing survive) instead of pruning it blindly (PRR-010);
 *  - an aborted create whose compensation FAILS says so and carries the id,
 *    rather than claiming the session was removed (PRR-007).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import {
	clearV2SessionClientState,
	createV2SessionClient,
} from '../../../../src/host/v2/session-client';
import type { V2PluginContext } from '../../../../src/host/v2/types';
import { resetSwarmState } from '../../../../src/state';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

const PARENT_DIR = '/proj/root';

interface LaneClient {
	session: {
		create: (args: {
			body?: { parentID?: string; title?: string };
			query: { directory: string };
			signal?: AbortSignal;
		}) => Promise<{
			data: { id: string } | null;
			error?: { message?: string; sessionID?: string; cleanupFailed?: boolean };
		}>;
		delete: (args: { path: { id: string } }) => Promise<unknown>;
		get: (args: { path: { id: string } }) => Promise<{ data: unknown }>;
	};
}

interface Overrides {
	create?: () => Promise<unknown>;
	remove?: () => Promise<void>;
}

function makeFakeSessionDomain(laneDir: string, overrides: Overrides = {}) {
	const calls: Array<{ op: string; arg: unknown }> = [];
	let next = 0;
	return {
		calls,
		async hook() {
			return { dispose: async () => {} };
		},
		async create(input: { location?: { directory: string } }) {
			calls.push({ op: 'create', arg: input });
			if (overrides.create) return overrides.create();
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
			return { id: sessionID, location: { directory: laneDir } };
		},
		async remove({ sessionID }: { sessionID: string }) {
			calls.push({ op: 'remove', arg: sessionID });
			if (overrides.remove) await overrides.remove();
		},
		async prompt() {
			return {};
		},
		async wait() {},
		async context() {
			return [];
		},
		async interrupt() {},
		async switchAgent() {},
		async switchModel() {},
	};
}

function makeClient(
	laneDir: string,
	overrides: Overrides = {},
): { client: LaneClient; fake: ReturnType<typeof makeFakeSessionDomain> } {
	const fake = makeFakeSessionDomain(laneDir, overrides);
	const registration = { dispose: async () => {} };
	const client = createV2SessionClient({
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
	return { client, fake };
}

describe('eager-lane failure branches (#3169 Phase 3)', () => {
	let laneDir: string;

	beforeEach(() => {
		resetSwarmState();
		clearV2SessionClientState();
		laneDir = canonicalMkdtemp('swarm-v2-fail-');
	});

	afterEach(() => {
		rmSync(laneDir, { recursive: true, force: true });
		clearV2SessionClientState();
		resetSwarmState();
	});

	test('a REJECTING create resolves to the typed envelope (PRR-006)', async () => {
		const { client } = makeClient(laneDir, {
			create: async () => {
				throw new Error('host exploded');
			},
		});
		const result = await client.session.create({
			body: { parentID: 'ses_parent' },
			query: { directory: laneDir },
		});
		expect(result.data).toBeNull();
		expect(result.error?.message).toContain('host exploded');
	});

	test('a mismatched landing whose cleanup FAILS reports the session id (PRR-010)', async () => {
		const { client } = makeClient(laneDir, {
			create: async () => ({
				id: 'ses_misplaced',
				location: { directory: PARENT_DIR },
			}),
			remove: async () => {
				throw new Error('device busy');
			},
		});
		const result = await client.session.create({
			body: { parentID: 'ses_parent' },
			query: { directory: laneDir },
		});
		expect(result.data).toBeNull();
		expect(result.error?.cleanupFailed).toBe(true);
		expect(result.error?.sessionID).toBe('ses_misplaced');
		expect(result.error?.message).toContain('device busy');
	});

	test('a long host-reported path is truncated in the placement message (PRR-011)', async () => {
		const longPath = `${laneDir}/${'x'.repeat(600)}`;
		const { client } = makeClient(laneDir, {
			create: async () => ({
				id: 'ses_long',
				location: { directory: longPath },
			}),
		});
		const result = await client.session.create({
			body: { parentID: 'ses_parent' },
			query: { directory: laneDir },
		});
		expect(result.error?.message).toContain('truncated');
		expect(result.error?.message).not.toContain('x'.repeat(600));
	});

	test('a delete whose removal FAILS keeps the eager record (PRR-010)', async () => {
		const { client } = makeClient(laneDir);
		const created = await client.session.create({
			body: { parentID: 'ses_parent' },
			query: { directory: laneDir },
		});
		const id = created.data!.id;
		// Make the subsequent removal reject.
		const failing = makeClient(laneDir, {
			remove: async () => {
				throw new Error('host remove failed');
			},
		});
		await failing.client.session.delete({ path: { id } });
		// The record must still resolve — a blindly-pruned record would have
		// dropped the parentID overlay the enforcement consumers rely on.
		const info = await failing.client.session.get({ path: { id } });
		expect((info.data as { parentID?: string }).parentID).toBe('ses_parent');
	});

	test('an aborted create whose compensation FAILS says so (PRR-007)', async () => {
		const { client } = makeClient(laneDir, {
			remove: async () => {
				throw new Error('host remove failed');
			},
		});
		const controller = new AbortController();
		controller.abort();
		const result = await client.session.create({
			body: { parentID: 'ses_parent' },
			query: { directory: laneDir },
			signal: controller.signal,
		});
		expect(result.data).toBeNull();
		expect(result.error?.message).toContain('also failed');
		expect(result.error?.message).not.toContain('was removed');
		expect(result.error?.sessionID).toBe('ses_real_1');
	});
});
