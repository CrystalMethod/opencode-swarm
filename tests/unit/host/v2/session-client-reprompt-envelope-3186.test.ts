/**
 * PR #3186 review feedback regressions for the v2 session-client shim:
 * PRR-002 (a re-prompt on the same placeholder id must not orphan the
 * superseded host session) and PRR-006 (shim `get` must normalize host
 * rejections into the v1 `{data, error}` envelope instead of rejecting).
 * Fakes only; no mock.module, no clock reads.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import {
	clearV2SessionClientState,
	createV2SessionClient,
} from '../../../../src/host/v2/session-client';
import type { V2PluginContext } from '../../../../src/host/v2/types';
import { resetSwarmState } from '../../../../src/state';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

interface FakeDomain {
	calls: Array<{ op: string; arg: unknown }>;
	createdSessions: Array<{
		id: string;
		input: { location?: { directory: string } };
	}>;
	removedSessions: Set<string>;
	contextEntries: unknown[];
	nextId: number;
}

function makeFakeDomain(
	directory: string,
): FakeDomain & Record<string, unknown> {
	const fake: FakeDomain = {
		calls: [],
		createdSessions: [],
		removedSessions: new Set(),
		contextEntries: [
			{ role: 'user', text: 'p' },
			{ role: 'assistant', text: 'reply' },
			{ type: 'idle', outcome: 'succeeded' },
		],
		nextId: 0,
	};
	return {
		...fake,
		async hook(_name: string, _callback: unknown) {
			return { dispose: async () => {} };
		},
		async create(input: { location?: { directory: string } }) {
			fake.calls.push({ op: 'create', arg: input });
			fake.nextId += 1;
			const id = `ses_real_${fake.nextId}`;
			fake.createdSessions.push({ id, input });
			return { id, location: input.location ?? { directory } };
		},
		async get({ sessionID }: { sessionID: string }) {
			fake.calls.push({ op: 'get', arg: sessionID });
			if (fake.removedSessions.has(sessionID)) {
				throw new Error('no such session');
			}
			return { id: sessionID, location: { directory } };
		},
		async remove({ sessionID }: { sessionID: string }) {
			fake.calls.push({ op: 'remove', arg: sessionID });
			fake.removedSessions.add(sessionID);
		},
		async prompt(input: unknown) {
			fake.calls.push({ op: 'prompt', arg: input });
			return {};
		},
		async wait(input: unknown) {
			fake.calls.push({ op: 'wait', arg: input });
		},
		async context(input: unknown) {
			fake.calls.push({ op: 'context', arg: input });
			return fake.contextEntries;
		},
		async interrupt(input: unknown) {
			fake.calls.push({ op: 'interrupt', arg: input });
		},
	} as FakeDomain & Record<string, unknown>;
}

function makeFakeCtx(directory: string, domain: unknown): V2PluginContext {
	return {
		app: { name: 'opencode', version: 'test', channel: 'test' },
		location: { directory, workspaceID: 'w' },
		options: {},
		tool: {},
		agent: {},
		command: {},
		session: domain,
		event: {},
	} as never;
}

afterEach(() => {
	resetSwarmState();
	clearV2SessionClientState();
});

describe('v2 session-client review-feedback regressions (PR #3186)', () => {
	// PRR-002: curator/skill-improver/mutation-generator re-prompt the SAME
	// placeholder id per fallback-model attempt. Minting a second host session
	// without retiring the first orphans it forever (teardown only reaches the
	// newest realId).
	test('PRR-002 a re-prompt on the same placeholder removes the superseded session (no orphan)', async () => {
		const directory = canonicalMkdtemp('swarm-v2-reprompt-');
		try {
			const domain = makeFakeDomain(directory);
			const client = createV2SessionClient(makeFakeCtx(directory, domain))!;
			const session = client.session as never as {
				create: (args: unknown) => Promise<{ data: { id: string } | null }>;
				prompt: (args: unknown) => Promise<unknown>;
				delete: (args: { path: { id: string } }) => Promise<unknown>;
			};
			const created = await session.create({
				body: { title: 't' },
				query: { directory },
			});
			const placeholderId = created.data!.id;

			await session.prompt({
				path: { id: placeholderId },
				body: { parts: [{ type: 'text', text: 'attempt 1' }] },
			});
			const firstRealId = domain.createdSessions[0]!.id;

			// The fallback attempt re-prompts the SAME placeholder id.
			const second = (await session.prompt({
				path: { id: placeholderId },
				body: { parts: [{ type: 'text', text: 'attempt 2' }] },
			})) as { data: { info?: unknown; parts?: unknown[] } | null };
			const secondRealId = domain.createdSessions[1]!.id;

			// The superseded session was removed BEFORE the second create, and no
			// stale parked flag removed the fresh session behind the shim's back.
			const removes = domain.calls.filter((c) => c.op === 'remove');
			expect(removes).toHaveLength(1);
			expect(removes[0]!.arg).toBe(firstRealId);
			expect(domain.removedSessions.has(firstRealId)).toBe(true);

			// The second attempt still produced a real reply.
			expect(second.data).not.toBeNull();
			expect(
				(second.data as { parts?: Array<{ text?: string }> }).parts?.[0],
			).toEqual({ type: 'text', text: 'reply' });

			// Teardown reaches the newest session; nothing is left orphaned.
			await session.delete({ path: { id: placeholderId } });
			expect(domain.removedSessions.has(secondRealId)).toBe(true);
			expect(
				domain.createdSessions.filter((s) => !domain.removedSessions.has(s.id)),
			).toHaveLength(0);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	// PRR-006: v1 SDK clients resolve error responses to `{error}` envelopes,
	// so consumers branch on result.error or wrap their own try/catch. The shim
	// must forward rejections as the envelope, never raw.
	test('PRR-006 shim get resolves a host rejection to the {data:null,error} envelope', async () => {
		const directory = canonicalMkdtemp('swarm-v2-getenv-');
		try {
			const domain = makeFakeDomain(directory);
			const client = createV2SessionClient(makeFakeCtx(directory, domain))!;
			const session = client.session as never as {
				remove: (args: { path: { id: string } }) => Promise<unknown>;
				get: (args: {
					path: { id: string };
				}) => Promise<{ data: unknown; error?: unknown }>;
			};
			// The fake get rejects for a removed session id.
			await domain.remove({ sessionID: 'ses_ghost' } as never);
			const result = await session.get({ path: { id: 'ses_ghost' } });
			expect(result.data).toBeNull();
			expect(result.error).toBeInstanceOf(Error);
			expect((result.error as Error).message).toBe('no such session');
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	// Same-PRR-006 blast radius: the parented-create placement precheck
	// consumes the shim get through a .catch, so a rejecting parent get must
	// still fail closed with the typed unverifiable-placement error rather
	// than throwing through the create call.
	test('PRR-006 parented create fails closed when the parent get rejects', async () => {
		const directory = canonicalMkdtemp('swarm-v2-plc-');
		try {
			const domain = makeFakeDomain(directory);
			const client = createV2SessionClient(makeFakeCtx(directory, domain))!;
			const session = client.session as never as {
				remove: (args: { path: { id: string } }) => Promise<unknown>;
				create: (args: unknown) => Promise<{
					data: { id: string } | null;
					error?: { message?: string };
				}>;
			};
			await domain.remove({ sessionID: 'ses_ghost' } as never);
			const result = await session.create({
				body: { parentID: 'ses_ghost' },
				query: { directory },
			});
			expect(result.data).toBeNull();
			expect(result.error?.message).toContain(
				'parent session placement unverifiable',
			);
			expect(domain.createdSessions).toHaveLength(0);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
