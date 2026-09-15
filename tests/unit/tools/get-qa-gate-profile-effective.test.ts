/**
 * Effective-gates surface tests for the get_qa_gate_profile tool (#2668).
 *
 * The tool must report the EFFECTIVE gates (durable profile merged with the
 * calling session's ratchet-tighter overrides) so an agent can inspect the
 * effective runtime policy after a restart.
 *
 * Surface note (frozen acceptance check C2 contract): these tests call
 * `get_qa_gate_profile.execute(args, ctx)` directly, which exercises the
 * executor through the createSwarmTool wrapper — the wrapper does NOT parse
 * args against the registered zod schema, so a companion assertion checks
 * the registered `args` schema still accepts the documented inputs (schema
 * surface not drifted).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { getOrCreateProfileForIdentity } from '../../../src/db/qa-gate-profile.js';
import {
	getOverrideForSession,
	setOverrideForSession,
} from '../../../src/db/qa-gate-session-override.js';
import {
	getAgentSession,
	resetSwarmState,
	startAgentSession,
} from '../../../src/state.js';
import {
	executeGetQaGateProfile,
	get_qa_gate_profile,
} from '../../../src/tools/get-qa-gate-profile.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let tempDir: string;
const SESSION = 'sess-tool-2668';
const IDENTITY = {
	swarm: 'sw-tool-2668',
	title: 'Effective gates tool test plan',
};

function ctxFor(directory: string, sessionID?: string): ToolContext {
	return {
		sessionID,
		messageID: 'msg-tool-2668',
		agent: 'architect',
		directory,
		worktree: directory,
		abort: new AbortController().signal,
		metadata: () => {},
		ask: async () => {},
	} as unknown as ToolContext;
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('qa-gate-profile-tool-test-');
});

afterEach(() => {
	resetSwarmState();
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

describe('get_qa_gate_profile effective-gates surface (#2668)', () => {
	test('executor returns effective gates merged with the live session override', async () => {
		getOrCreateProfileForIdentity(tempDir, IDENTITY); // mutation_test=false
		startAgentSession(SESSION, 'architect', 7_200_000, tempDir);
		const session = getAgentSession(SESSION);
		session!.qaGateSessionOverrides = { mutation_test: true };

		const result = await executeGetQaGateProfile(
			{ swarm_id: IDENTITY.swarm, plan_title: IDENTITY.title },
			tempDir,
			ctxFor(tempDir, SESSION),
		);
		expect(result.success).toBe(true);
		expect(result.session_overrides).toEqual({ mutation_test: true });
		expect(result.effective_gates?.mutation_test).toBe(true);
		// Spec-level profile is NOT widened by the session override.
		expect(result.profile?.gates.mutation_test).toBe(false);
	});

	test('falls back to the durable override row when the live session is absent', async () => {
		getOrCreateProfileForIdentity(tempDir, IDENTITY);
		setOverrideForSession(tempDir, SESSION, { mutation_test: true });
		// No live session — the restart authority row answers instead.
		expect(getAgentSession(SESSION)).toBeUndefined();

		const result = await executeGetQaGateProfile(
			{ swarm_id: IDENTITY.swarm, plan_title: IDENTITY.title },
			tempDir,
			ctxFor(tempDir, SESSION),
		);
		expect(result.success).toBe(true);
		expect(result.effective_gates?.mutation_test).toBe(true);
	});

	test('without a session context the effective gates equal the profile gates', async () => {
		const profile = getOrCreateProfileForIdentity(tempDir, IDENTITY);
		const result = await executeGetQaGateProfile(
			{ swarm_id: IDENTITY.swarm, plan_title: IDENTITY.title },
			tempDir,
			ctxFor(tempDir, undefined),
		);
		expect(result.success).toBe(true);
		expect(result.session_overrides).toEqual({});
		expect(result.effective_gates).toEqual(profile.gates);
	});

	test('registered args schema still accepts the documented inputs (schema surface not drifted)', () => {
		// The registered `args` is a per-field zod shape (createSwarmTool adds
		// working_directory); assert the documented fields exist and validate.
		const args = (
			get_qa_gate_profile as unknown as {
				args?: Record<
					string,
					{ safeParse: (input: unknown) => { success: boolean } }
				>;
			}
		).args;
		expect(args).toBeDefined();
		expect(args!.swarm_id).toBeDefined();
		expect(args!.plan_title).toBeDefined();
		expect(args!.swarm_id.safeParse(IDENTITY.swarm).success).toBe(true);
		expect(args!.swarm_id.safeParse('  ').success).toBe(false);
		expect(args!.plan_title.safeParse(IDENTITY.title).success).toBe(true);
	});
});
