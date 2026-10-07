import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { _test_exports as gateInternals } from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals as dispatchInternals,
	executeDispatchLanesAsync,
} from '../../../src/tools/dispatch-lanes.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';

// Issue #2835 acceptance check C7 (PRESERVING — GREEN at base, must STAY green
// after the fix).
//
// AC5 first half: lanes cannot be launched with an empty revision_digest
// contract token — dispatch-time digest resolution already hard-throws
// (dispatch-lanes.ts:1388-1393:
// "BLOCKED: PR workflow could not compute a bounded current-revision digest
// for pr_head_sha ..."), which makes the empty-digest render sites unreachable
// from a real dispatch. This probe pins that fail-fast guard at the exact
// seam dispatch uses: when the resolver yields no digest, the dispatch is
// rejected with that BLOCKED message before any lane prompt is built.

const SESSION_ID = 'c7-digest-guard-session';
const HEAD_SHA = 'abc123';
const BASE_SHA = 'def456';
const BASE_REF = 'origin/main';
const BLOCKED_MESSAGE =
	'BLOCKED: PR workflow could not compute a bounded current-revision digest';

const originals = {
	gateHead: gateInternals.resolveCurrentGitHead,
	gateHeadAsync: gateInternals.resolveCurrentGitHeadAsync,
	gateClean: gateInternals.resolveIsWorkingTreeClean,
	gateCleanAsync: gateInternals.resolveIsWorkingTreeCleanAsync,
	dispatchDigest: dispatchInternals.resolvePrWorkflowRevisionDigestAsync,
	dispatchMergeBase: dispatchInternals.resolveExactMergeBaseAsync,
	loadPluginConfig: dispatchInternals.loadPluginConfig,
	getSessionOps: dispatchInternals.getSessionOps,
};

let directory = '';

beforeEach(async () => {
	directory = canonicalMkdtemp('c7-digest-guard-');
	await initializeGitRepository(directory);
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveCurrentGitHeadAsync = async (dir) =>
		gateInternals.resolveCurrentGitHead(dir);
	gateInternals.resolveIsWorkingTreeCleanAsync = async (dir) =>
		gateInternals.resolveIsWorkingTreeClean(dir);
	// The exact unit seam dispatch uses for digest resolution
	// (dispatch-lanes.ts:1370-1382): an overridden resolver returning a null
	// digest maps to { ok: false, reason: 'seam-unavailable' } and must
	// hard-fail the dispatch.
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async () => null;
	dispatchInternals.resolveExactMergeBaseAsync = async () => BASE_SHA;
	dispatchInternals.getSessionOps = () => ({
		create: mock(async () => ({ data: { id: 'c7-lane-session' } })),
		promptAsync: mock(async () => ({ data: undefined, error: undefined })),
		delete: mock(async () => undefined),
	});
});

afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = originals.gateHead;
	gateInternals.resolveCurrentGitHeadAsync = originals.gateHeadAsync;
	gateInternals.resolveIsWorkingTreeClean = originals.gateClean;
	gateInternals.resolveIsWorkingTreeCleanAsync = originals.gateCleanAsync;
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync =
		originals.dispatchDigest;
	dispatchInternals.resolveExactMergeBaseAsync = originals.dispatchMergeBase;
	dispatchInternals.loadPluginConfig = originals.loadPluginConfig;
	dispatchInternals.getSessionOps = originals.getSessionOps;
	rmSync(directory, { recursive: true, force: true });
});

describe('C7: dispatch-time digest resolution failure hard-fails the dispatch before any lane launches', () => {
	test('a null digest resolution yields the BLOCKED current-revision digest rejection', async () => {
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: BASE_REF,
				lanes: [
					{
						id: 'base-lane-intent-architecture',
						agent: 'explorer',
						prompt: 'Inspect the exact reviewed diff.',
						workflow_lane: 'intent-architecture',
					},
				],
			},
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain(BLOCKED_MESSAGE);
	});
});
