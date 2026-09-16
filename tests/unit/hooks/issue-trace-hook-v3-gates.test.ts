/**
 * Hook-level gate tests for the v3 receipts (issue #2564 PR-review F-003):
 * drives createIssueTraceHook — not just the reducer/reader layer — for the
 * two paths the review identified as hook-uncovered:
 *   1. a FAILING trace-validation entry blocks the commit-pr handoff;
 *   2. a fetch-failed freshness receipt WITH a recorded override permits PLAN.
 * Under 500 lines (FR-006).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	createIssueTraceHook,
	resetApprovalCache,
	resetPhaseStatusCache,
} from '../../../src/hooks/issue-trace';
import type { TraceState } from '../../../src/hooks/issue-trace-reducer';
import {
	type GuidanceMessage,
	isGuidanceCarrier,
	messageTextOf,
} from '../../../src/hooks/system-guidance-carrier';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tmpDir: string;

beforeEach(() => {
	tmpDir = canonicalMkdtemp('hook-v3-gates-');
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
});

const originals = { ..._internals };
afterEach(() => {
	Object.assign(_internals, originals);
	resetApprovalCache();
	resetPhaseStatusCache();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeJson(name: string, data: unknown): void {
	fs.writeFileSync(
		path.join(tmpDir, '.swarm', name),
		JSON.stringify(data, null, 2),
		'utf-8',
	);
}

function writeIssueRef(): void {
	writeJson('issue-reference.json', {
		url: 'https://github.com/owner/repo/issues/42',
		owner: 'owner',
		repo: 'repo',
		number: 42,
		timestamp: '2026-01-01T00:00:00Z',
		flags: { trace: true, noRepro: true },
	});
}

function writeTraceState(over: Partial<TraceState> = {}): void {
	writeJson('issue-trace-state.json', {
		issueNumber: 42,
		lastTransition: null,
		status: 'in_progress',
		...over,
	});
}

function writeSpec(): void {
	fs.writeFileSync(
		path.join(tmpDir, '.swarm', 'spec.md'),
		'# Spec\n\n## Source Issue\n\n- Number: 42\n',
		'utf-8',
	);
}

function writeResidualBReceipts(): void {
	writeJson('implementation-review.json', {
		issueNumber: 42,
		reviewerVerdict: 'APPROVE',
		criticVerdict: 'APPROVE',
		diffBase: 'abc1234',
		diffHead: 'def5678',
	});
	writeJson('recurrence-sweep.json', {
		issueNumber: 42,
		defectClass: 'no defect class',
		justification: 'docs-only change corrects no behavior',
		relatedProblems: [{ ref: '#2131' }],
	});
}

function completePlan(): void {
	_internals.isPlanCriticApproved = () => Promise.resolve(true);
	_internals.readPlanPhaseStatus = () =>
		Promise.resolve({ planExists: true, allComplete: true });
}

async function runHook(): Promise<{
	messages: unknown[];
	state: TraceState | null;
}> {
	const hook = createIssueTraceHook({}, tmpDir, 100);
	const output = { messages: [] as unknown[] };
	await hook.messagesTransform({}, output);
	const raw = fs.readFileSync(
		path.join(tmpDir, '.swarm', 'issue-trace-state.json'),
		'utf-8',
	);
	return { messages: output.messages, state: JSON.parse(raw) as TraceState };
}

describe('hook-level v3 gates (PR #2783 review F-003)', () => {
	test('a FAILING trace-validation entry blocks the commit-pr handoff', async () => {
		writeIssueRef();
		writeTraceState({ lastTransition: 'PLAN_TO_EXECUTE' });
		writeSpec();
		completePlan();
		writeResidualBReceipts();
		writeJson('branch-freshness.json', {
			issueNumber: 42,
			freshness: 'synced',
		});
		// One green entry plus one FAILING entry: the reader must fail closed,
		// so the hook emits the TRACE_VALIDATION_GATE directive instead of the
		// commit-pr handoff.
		writeJson('trace-validation.json', {
			issueNumber: 42,
			validations: [
				{
					phase: '0',
					outcome: 'pass',
					reviewedCommit: '0123456789abcdef0123456789abcdef01234567',
					treeId: 'fedcba9876543210fedcba9876543210fedcba98',
				},
				{
					phase: '4.6',
					outcome: 'fail',
					reviewedCommit: '0123456789abcdef0123456789abcdef01234567',
					treeId: 'fedcba9876543210fedcba9876543210fedcba98',
				},
			],
		});

		const { messages, state } = await runHook();
		// Two carriers: the [MODE: EXECUTE] mode signal plus the gate directive.
		expect(messages).toHaveLength(2);
		const text = messages
			.filter((m) => isGuidanceCarrier(m))
			.map((m) => messageTextOf(m as GuidanceMessage))
			.join('\n');
		expect(text).toMatch(/\[MODE: EXECUTE\]/);
		expect(text).toMatch(/trace-check|validator|validation/i);
		// The commit-pr HANDOFF directive opens with "Compose commit-pr"; the
		// gate directive merely names the gate it is blocking.
		expect(text).not.toContain('Compose commit-pr');
		expect(state?.lastTransition).toBe('TRACE_VALIDATION_GATE');
		expect(state?.status).toBe('in_progress');
	});

	test('a fetch-failed freshness receipt WITH an override permits PLAN', async () => {
		writeIssueRef();
		writeTraceState();
		writeSpec();
		writeJson('branch-freshness.json', {
			issueNumber: 42,
			freshness: 'fetch-failed:network-offline',
			override: 'user accepted proceeding on the stale base',
		});

		const { messages, state } = await runHook();
		expect(messages).toHaveLength(1);
		expect(isGuidanceCarrier(messages[0])).toBe(true);
		const text = messageTextOf(messages[0] as GuidanceMessage);
		expect(text).toContain('[MODE: PLAN]');
		expect(state?.lastTransition).toBe('ISSUE_INGEST_TO_PLAN');
		expect(state?.status).toBe('in_progress');
	});
});
