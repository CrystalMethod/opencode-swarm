import { describe, expect, test } from 'bun:test';
import { evaluateFragmentCheck } from '../../../scripts/check-pending-fragment';

/**
 * Acceptance checks for issue #2677.
 *
 * The required-check and release-owner evaluators are intentionally loaded
 * lazily: they are the NEW-SURFACE introduced by the issue and are expected
 * to be absent on the Phase-0 tree. Keeping the fixtures here makes the
 * contract executable without coupling it to a workflow implementation.
 */

const requiredContexts = ['quality', 'unit', 'drift'];

const healthyContract = {
	contract: { requiredContexts },
	workflows: [
		{
			file: '.github/workflows/ci.yml',
			events: ['pull_request', 'merge_group'],
			contexts: ['quality', 'unit'],
		},
		{
			file: '.github/workflows/drift-check.yml',
			events: ['pull_request', 'push', 'merge_group'],
			contexts: ['drift'],
		},
	],
	evidence: {
		ruleset: { requiredContexts },
		branch: { name: 'main', protected: true },
		mergeGroup: { contexts: requiredContexts },
		workflowEvents: {
			ci: ['pull_request', 'merge_group'],
			drift: ['pull_request', 'push', 'merge_group'],
		},
	},
};

async function requiredCheckContract() {
	return import('../../../scripts/check-required-check-contract.ts');
}

async function releaseOwnership() {
	return import('../../../scripts/check-required-check-contract.ts');
}

describe('issue #2677 acceptance checks', () => {
	test('AC1: a complete contract matches ruleset and workflow event evidence', async () => {
		const { evaluateRequiredCheckContract } = await requiredCheckContract();
		const result = evaluateRequiredCheckContract(healthyContract);

		expect(result.status).toBe('pass');
		expect(result.findings).toEqual([]);
		expect(result.unknown).toEqual([]);
	});

	test('AC2: present, absent, renamed, and event-skipped contexts are distinct', async () => {
		const { evaluateRequiredCheckContract } = await requiredCheckContract();

		const present = evaluateRequiredCheckContract(healthyContract);
		expect(present.findings).toEqual([]);

		const absent = evaluateRequiredCheckContract({
			...healthyContract,
			evidence: {
				...healthyContract.evidence,
				ruleset: { requiredContexts: ['quality', 'unit'] },
				mergeGroup: { contexts: ['quality', 'unit'] },
			},
		});
		expect(absent.findings.map((finding) => finding.code)).toContain(
			'PROMISED_CONTEXT_MISSING',
		);

		const renamed = evaluateRequiredCheckContract({
			...healthyContract,
			workflows: healthyContract.workflows.map((workflow) =>
				workflow.file.endsWith('ci.yml')
					? { ...workflow, contexts: ['quality', 'unit-renamed'] }
					: workflow,
			),
			evidence: {
				...healthyContract.evidence,
				ruleset: { requiredContexts: ['quality', 'unit-renamed', 'drift'] },
				mergeGroup: { contexts: ['quality', 'unit-renamed', 'drift'] },
			},
		});
		expect(renamed.findings.map((finding) => finding.code)).toContain(
			'PROMISED_CONTEXT_RENAMED',
		);

		const eventSkipped = evaluateRequiredCheckContract({
			...healthyContract,
			workflows: healthyContract.workflows.map((workflow) =>
				workflow.file.endsWith('drift-check.yml')
					? { ...workflow, events: ['pull_request', 'push'] }
					: workflow,
			),
			evidence: {
				...healthyContract.evidence,
				workflowEvents: {
					...healthyContract.evidence.workflowEvents,
					drift: ['pull_request', 'push'],
				},
			},
		});
		expect(eventSkipped.findings.map((finding) => finding.code)).toContain(
			'PROMISED_CONTEXT_EVENT_SKIPPED',
		);
	});

	test('AC3: unavailable external evidence is unknown and cannot close locally', async () => {
		const { evaluateRequiredCheckContract } = await requiredCheckContract();
		const result = evaluateRequiredCheckContract({
			...healthyContract,
			evidence: {
				ruleset: null,
				branch: null,
				mergeGroup: null,
				workflowEvents: null,
			},
		});

		expect(result.status).toBe('unknown');
		expect(result.ok).toBe(false);
		expect(result.unknown).toEqual(
			expect.arrayContaining([
				'ruleset',
				'branch',
				'merge_group',
				'workflow_events',
			]),
		);
	});

	test('AC4: release ownership allows only the automation exception', async () => {
		const { evaluateReleaseOwnership } = await releaseOwnership();
		const ownerFiles = [
			'package.json',
			'CHANGELOG.md',
			'.release-please-manifest.json',
		];

		const unauthorized = evaluateReleaseOwnership({
			changedFiles: ownerFiles,
			actor: 'contributor',
			event: 'pull_request',
		});
		expect(unauthorized.ok).toBe(false);
		expect(unauthorized.code).toBe('UNAUTHORIZED_RELEASE_OWNER_EDIT');

		const automation = evaluateReleaseOwnership({
			changedFiles: ownerFiles,
			actor: 'release-please[bot]',
			event: 'pull_request',
			releaseAutomation: true,
			tagName: 'v9.9.9',
		});
		expect(automation.ok).toBe(true);
		expect(automation.code).toBe('RELEASE_AUTOMATION_EXCEPTION');
		expect(automation.requiredNotes).toEqual([]);
	});

	test('AC5: pending fragments remain normal and tags never create versioned notes', async () => {
		const { evaluateReleaseOwnership } = await releaseOwnership();

		const fragment = evaluateFragmentCheck({
			changedFiles: ['src/index.ts', 'docs/releases/pending/issue-2677.md'],
			addedFiles: ['docs/releases/pending/issue-2677.md'],
		});
		expect(fragment.violation).toBe(false);

		const ordinary = evaluateReleaseOwnership({
			changedFiles: ['src/index.ts'],
			addedFiles: ['docs/releases/pending/issue-2677.md'],
			actor: 'contributor',
			event: 'pull_request',
			tagName: 'v9.9.9',
		});
		expect(ordinary.ok).toBe(true);
		expect(ordinary.requiredNotes).toEqual([]);
		expect(ordinary.requiredNotes).not.toContain('docs/releases/v9.9.9.md');

		const ownerWithFragment = evaluateReleaseOwnership({
			changedFiles: ['package.json', 'docs/releases/pending/issue-2677.md'],
			addedFiles: ['docs/releases/pending/issue-2677.md'],
			actor: 'contributor',
			event: 'pull_request',
		});
		expect(ownerWithFragment.ok).toBe(false);
		expect(ownerWithFragment.code).toBe('UNAUTHORIZED_RELEASE_OWNER_EDIT');
	});

	test('AC5: a demoted previous context is named even when no other arm can fire (MUT-1, issue #2955)', async () => {
		const { evaluateRequiredCheckContract } = await requiredCheckContract();

		// Isolating fixture for the CONTRACT_BUCKET_DEMOTION baseline arm
		// (scripts/check-required-check-contract.ts:425-436): 'drift' is in
		// NEITHER requiredContexts NOR intendedRequiredContexts NOR the
		// captured ruleset, so only the :427 baseline loop can emit the
		// finding. The wiring-2677 "stale or demoted" test is OR-shaped — its
		// fixture (previous ['quality'], required [], intended ['quality'])
		// is also satisfied by the :702 intended-only arm, which is why the
		// G2 `false &&` mutation at :427 survived the whole suite before
		// this test (issue #2955 MUT-1).
		//
		// Coverage note: the evidence shape is deliberately minimal (mirrors
		// the wiring-2677 precedent in the same family) so some
		// malformed-evidence co-findings fire alongside; those arms are
		// covered by the evidence/wiring 2677 suites. The assertions are
		// code-filtered so they pin THIS arm exactly.
		const base = {
			contract: { requiredContexts: ['unit'], intendedRequiredContexts: [] },
			previousRequiredContexts: ['unit', 'drift'],
			workflows: [
				{
					file: 'ci.yml',
					events: ['pull_request', 'merge_group'],
					contexts: ['unit'],
				},
			],
			evidence: {
				schemaVersion: 1,
				capturedAt: '2020-01-01T00:00:00Z',
				captureSha: 'b21cdce',
				repository: 'ZaxbyHub/opencode-swarm',
				branch: { name: 'main', protected: true, rulesetId: '17809658' },
				ruleset: {
					id: '17809658',
					enforcement: 'active',
					requiredContexts: ['unit'],
				},
				mergeGroup: { known: true, contexts: ['unit'] },
				workflowEvents: { 'ci.yml': ['pull_request', 'merge_group'] },
				sources: [{ endpoint: 'https://api.github.com/example' }],
			},
		};

		const demoted = evaluateRequiredCheckContract(base, {
			now: new Date('2020-01-02T00:00:00Z'),
		});
		const demotionFindings = demoted.findings.filter(
			(finding) => finding.code === 'CONTRACT_BUCKET_DEMOTION',
		);
		expect(demotionFindings.length).toBe(1);
		expect(demotionFindings[0]?.severity).toBe('error');
		// addFinding flattens the per-finding detail payload (here
		// { context: previous }) onto the finding itself.
		expect(
			demotionFindings.some(
				(finding) => (finding as { context?: string }).context === 'drift',
			),
		).toBe(true);

		// Negative control: with 'drift' still required, no demotion fires.
		const healthy = evaluateRequiredCheckContract(
			{
				...base,
				previousRequiredContexts: ['unit', 'drift'],
				contract: {
					requiredContexts: ['unit', 'drift'],
					intendedRequiredContexts: [],
				},
				workflows: [
					{
						file: 'ci.yml',
						events: ['pull_request', 'merge_group'],
						contexts: ['unit'],
					},
					{
						file: 'drift-check.yml',
						events: ['pull_request', 'merge_group'],
						contexts: ['drift'],
					},
				],
			},
			{ now: new Date('2020-01-02T00:00:00Z') },
		);
		expect(
			healthy.findings.filter(
				(finding) => finding.code === 'CONTRACT_BUCKET_DEMOTION',
			),
		).toEqual([]);
	});
});
