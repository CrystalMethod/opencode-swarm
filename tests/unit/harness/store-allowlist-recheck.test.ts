import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_HARNESS_EVOLUTION_CONFIG } from '../../../src/config/schema.js';
import { createAgentFactory } from '../../../src/harness/factory.js';
import { sha256 } from '../../../src/harness/hash.js';
import { validateSourceCandidate } from '../../../src/harness/source-candidate.js';
import {
	activateHarnessCandidate,
	buildHarnessActivationApprovalRequest,
	buildHarnessRollbackApprovalRequest,
	loadHarnessCurrent,
	recordHarnessCandidate,
	rollbackHarnessVersion,
	type StoredHarnessCandidateV1,
} from '../../../src/harness/store.js';
import {
	computeWriteApprovalHash,
	issueWriteApprovalFact,
} from '../../../src/security/write-authority.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Issue #2503 store hardening: `activateHarnessCandidate` and
 * `rollbackHarnessVersion` re-validate a recorded candidate's approved paths
 * against the CURRENT harness_evolution allowlist when the caller supplies
 * the live config, refusing typed `allowlist_revoked` on revocation. Both
 * directions are pinned here; the frozen acceptance check C1 drives the
 * activation direction end-to-end through the real approval-fact chain.
 */
const TRACKED_REL = 'src/agents/demo.ts';

const PATCH = [
	`diff --git a/${TRACKED_REL} b/${TRACKED_REL}`,
	`--- a/${TRACKED_REL}`,
	`+++ b/${TRACKED_REL}`,
	'@@ -1 +1 @@',
	'-export const value = 1;',
	'+export const value = 2;',
	'',
].join('\n');

let root = '';

beforeEach(() => {
	root = canonicalMkdtemp('harness-recheck-');
	mkdirSync(path.join(root, 'src/agents'), { recursive: true });
	writeFileSync(path.join(root, TRACKED_REL), 'export const value = 1;\n');
	for (const args of [
		['init'],
		['add', '.'],
		[
			'-c',
			'user.name=Test',
			'-c',
			'user.email=test@example.invalid',
			'commit',
			'-m',
			'fixture',
		],
	]) {
		execFileSync('git', args, { cwd: root, timeout: 30_000, stdio: 'ignore' });
	}
});

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

function wideConfig() {
	return {
		...DEFAULT_HARNESS_EVOLUTION_CONFIG,
		source_allowlist: [TRACKED_REL],
	};
}

function tightenedConfig() {
	return {
		...DEFAULT_HARNESS_EVOLUTION_CONFIG,
		source_allowlist: ['src/agents/elsewhere.ts'],
	};
}

async function recordCandidate(id: string): Promise<StoredHarnessCandidateV1> {
	const head = execFileSync('git', ['rev-parse', 'HEAD'], {
		cwd: root,
		timeout: 30_000,
		stdio: ['ignore', 'pipe', 'ignore'],
	})
		.toString()
		.trim();
	const validated = await validateSourceCandidate({
		directory: root,
		config: wideConfig(),
		candidateId: id,
		baseSha: head,
		origin: `recheck-${id}`,
		patch: PATCH,
	});
	if (!validated.ok) throw new Error(`fixture rejected: ${validated.code}`);
	const blueprint = createAgentFactory({
		runtimeDefinitions: [
			{
				name: 'architect',
				config: {
					mode: 'primary',
					temperature: 0.1,
					prompt: 'Static runtime prompt',
					tools: {},
				},
			},
		],
		registeredToolIds: [],
	}).projectBlueprint({ blueprintId: `blueprint-${id}` });
	const stored: StoredHarnessCandidateV1 = {
		v: 1,
		baseBlueprint: blueprint,
		targetBlueprint: blueprint,
		blueprintPatch: {
			v: 1,
			patchId: `patch-${id}`,
			expectedBaseHash: blueprint.contentHash,
			expectedResultHash: blueprint.contentHash,
			operations: [],
		},
		candidate: validated.candidate,
		recordedAt: '2026-09-13T12:00:00.000Z',
	};
	const recorded = await recordHarnessCandidate({
		directory: root,
		candidate: stored,
	});
	if (recorded.status !== 'recorded') throw new Error(recorded.status);
	return stored;
}

function bindingFor(candidate: StoredHarnessCandidateV1) {
	return {
		expectedCurrentHash: null as string | null,
		expectedCurrentGeneration: 1,
		targetContentHash: candidate.candidate.manifestHash,
		allowedPathDigest: computeWriteApprovalHash({
			allowedPaths: [...candidate.candidate.approvedPaths].sort(),
		}),
	};
}

async function activate(
	candidate: StoredHarnessCandidateV1,
	config?: typeof DEFAULT_HARNESS_EVOLUTION_CONFIG,
) {
	const current = await loadHarnessCurrent(root);
	const binding = {
		...bindingFor(candidate),
		expectedCurrentHash:
			current.currentVersionId === null ? null : current.currentHash,
		expectedCurrentGeneration: current.generation,
	};
	await issueWriteApprovalFact({
		directory: root,
		request: buildHarnessActivationApprovalRequest({
			targetSessionId: 'session-a',
			candidate,
			...binding,
		}),
		issuingSessionId: 'human-session',
	});
	return activateHarnessCandidate({
		directory: root,
		candidateId: candidate.candidate.candidateId,
		consumerSessionId: 'session-a',
		...binding,
		config,
	});
}

describe('allowlist re-validation at activation and rollback (issue #2503)', () => {
	test('activation refuses with allowlist_revoked under a tightened config', async () => {
		const candidate = await recordCandidate('recheck-activate');
		const result = await activate(candidate, tightenedConfig());
		expect(result.status).toBe('allowlist_revoked');
		if ('reason' in result) {
			expect(`${result.status} ${result.reason}`).toMatch(/allowlist/i);
		}
	});

	test('activation still succeeds under the wide config that admitted the candidate', async () => {
		const candidate = await recordCandidate('recheck-wide');
		const result = await activate(candidate, wideConfig());
		expect(result.status).toBe('activated');
	});

	test('legacy callers without a config keep the pre-#2503 behavior', async () => {
		const candidate = await recordCandidate('recheck-legacy');
		const result = await activate(candidate);
		expect(result.status).toBe('activated');
	});

	test('rollback refuses with allowlist_revoked under a tightened config (symmetry)', async () => {
		const first = await recordCandidate('recheck-first');
		const second = await recordCandidate('recheck-second');
		const firstActivation = await activate(first, wideConfig());
		if (firstActivation.status !== 'activated') {
			throw new Error(firstActivation.status);
		}
		const secondActivation = await activate(second, wideConfig());
		if (secondActivation.status !== 'activated') {
			throw new Error(secondActivation.status);
		}
		const rollbackBinding = {
			targetVersionId: firstActivation.version.versionId,
			consumerSessionId: 'session-a',
			expectedCurrentHash: secondActivation.current.currentHash,
			expectedCurrentGeneration: secondActivation.current.generation,
			targetContentHash: first.candidate.manifestHash,
			allowedPathDigest: firstActivation.version.allowedPathDigest,
		};
		await issueWriteApprovalFact({
			directory: root,
			request: buildHarnessRollbackApprovalRequest({
				targetSessionId: 'session-a',
				currentVersionId: secondActivation.version.versionId,
				...rollbackBinding,
			}),
			issuingSessionId: 'human-session',
		});
		const rolledBack = await rollbackHarnessVersion({
			directory: root,
			...rollbackBinding,
			config: tightenedConfig(),
		});
		expect(rolledBack.status).toBe('allowlist_revoked');
		if ('reason' in rolledBack) {
			expect(`${rolledBack.status} ${rolledBack.reason}`).toMatch(/allowlist/i);
		}
	});

	test('rollback succeeds under the wide config', async () => {
		const first = await recordCandidate('recheck-rollback-a');
		const second = await recordCandidate('recheck-rollback-b');
		const firstActivation = await activate(first, wideConfig());
		const secondActivation = await activate(second, wideConfig());
		if (
			firstActivation.status !== 'activated' ||
			secondActivation.status !== 'activated'
		) {
			throw new Error('fixture activation failed');
		}
		const rollbackBinding = {
			targetVersionId: firstActivation.version.versionId,
			consumerSessionId: 'session-a',
			expectedCurrentHash: secondActivation.current.currentHash,
			expectedCurrentGeneration: secondActivation.current.generation,
			targetContentHash: first.candidate.manifestHash,
			allowedPathDigest: firstActivation.version.allowedPathDigest,
		};
		await issueWriteApprovalFact({
			directory: root,
			request: buildHarnessRollbackApprovalRequest({
				targetSessionId: 'session-a',
				currentVersionId: secondActivation.version.versionId,
				...rollbackBinding,
			}),
			issuingSessionId: 'human-session',
		});
		const rolledBack = await rollbackHarnessVersion({
			directory: root,
			...rollbackBinding,
			config: wideConfig(),
		});
		expect(rolledBack.status).toBe('rolled_back');
		expect((await loadHarnessCurrent(root)).currentCandidateId).toBe(
			first.candidate.candidateId,
		);
	});
});
