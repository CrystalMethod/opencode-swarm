/**
 * Shared fixtures for the v3 ingestion-journey tests (issue #2564). Drives the
 * REAL machinery only — handleIssueCommand, the real record_* receipt
 * executors, savePlan/loadPlan through the real ledger, approve_plan_critic
 * via ensureAgentSession, and the engine hook — with NO `_internals`
 * behavioral overrides. Non-test module (no FR-006 cap concern).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { handleIssueCommand } from '../../../src/commands/issue';
import {
	createIssueTraceHook,
	resetApprovalCache,
	resetPhaseStatusCache,
} from '../../../src/hooks/issue-trace';
import { readTraceState } from '../../../src/hooks/issue-trace-state';
import { loadPlan, savePlan } from '../../../src/plan/manager';
import { ensureAgentSession } from '../../../src/state';
import { executeApprovePlanCritic } from '../../../src/tools/approve-plan-critic';
import { executeRecordBranchFreshness } from '../../../src/tools/record-branch-freshness';
import { executeRecordImplementationReview } from '../../../src/tools/record-implementation-review';
import { executeRecordIssuePublication } from '../../../src/tools/record-issue-publication';
import { executeRecordIssueReproduction } from '../../../src/tools/record-issue-reproduction';
import { executeRecordMergeApproval } from '../../../src/tools/record-merge-approval';
import { executeRecordRecurrenceSweep } from '../../../src/tools/record-recurrence-sweep';
import { executeRecordTraceValidation } from '../../../src/tools/record-trace-validation';

export const JOURNEY_ISSUE = 2564;
export const PR_HEAD = '0123456789abcdef0123456789abcdef01234567';
export const TREE_ID = 'fedcba9876543210fedcba9876543210fedcba98';
export const JOURNEY_SESSION = 'journey-v3-architect';

export interface JourneyProject {
	dir: string;
	call: (
		fn: (
			args: unknown,
			dir: string,
			ctx: { sessionID: string },
		) => Promise<string>,
		args: unknown,
	) => Promise<Record<string, unknown>>;
	cycle: () => Promise<{
		text: string;
		state: {
			issueNumber: number;
			lastTransition: string | null;
			status: string;
		};
	}>;
	writeSpec: () => void;
	saveJourneyPlan: (phaseStatus: string, taskStatus: string) => Promise<void>;
	approveCritic: () => Promise<Record<string, unknown>>;
	recordFreshness: () => Promise<Record<string, unknown>>;
	recordRepro: () => Promise<Record<string, unknown>>;
	recordReview: () => Promise<Record<string, unknown>>;
	recordSweep: () => Promise<Record<string, unknown>>;
	recordValidation: () => Promise<Record<string, unknown>>;
	recordPublication: () => Promise<Record<string, unknown>>;
	recordMergeApproval: () => Promise<Record<string, unknown>>;
	resetCaches: () => void;
	cleanup: () => void;
}

export function createJourneyProject(): JourneyProject {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'journey-v3-')),
	);
	fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
	const swarm = (...p: string[]) => path.join(dir, '.swarm', ...p);
	const call: JourneyProject['call'] = (fn, args) =>
		fn(args, dir, { sessionID: JOURNEY_SESSION }).then((s) => JSON.parse(s));
	const cycle = async () => {
		const hook = createIssueTraceHook({}, dir, 300);
		const output = { messages: [] };
		await hook.messagesTransform({ messages: [] }, output);
		const text = output.messages
			.map((m: { parts?: Array<{ type?: string; text?: string }> }) =>
				Array.isArray(m?.parts)
					? m.parts
							.filter((p) => p?.type === 'text')
							.map((p) => p.text)
							.join('\n')
					: '',
			)
			.join('\n');
		return { text, state: readTraceState(dir) };
	};
	const planV = (phaseStatus: string, taskStatus: string) => ({
		schema_version: '1.0.0',
		title: 'Wire issue-tracer v3 receipts plugin-side (#2564)',
		swarm: 'architect',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Wire v3 receipt surfaces',
				status: phaseStatus,
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: taskStatus,
						description:
							'Add branch-freshness, trace-validation, and merge-approval receipts with reducer consumption',
						acceptance: 'AC1-AC9 acceptance table green post-fix',
						files_touched: ['src/hooks/issue-trace-reducer.ts'],
						fr_refs: ['FR-2564'],
					},
				],
			},
		],
	});
	return {
		dir,
		call,
		cycle,
		writeSpec: () => {
			fs.mkdirSync(swarm(), { recursive: true });
			fs.writeFileSync(
				swarm('spec.md'),
				'# Spec\n\n## Source Issue\n\n- Number: 2564\n\n## Details\n\nWire the v3 receipts.\n',
				'utf-8',
			);
		},
		saveJourneyPlan: async (phaseStatus, taskStatus) => {
			await savePlan(dir, planV(phaseStatus, taskStatus) as never);
		},
		approveCritic: () => {
			ensureAgentSession(JOURNEY_SESSION, 'architect');
			return call(executeApprovePlanCritic, {
				reason:
					'journey fixture: critic returned APPROVED for the v3 receipt wiring plan',
			});
		},
		recordFreshness: () =>
			call(executeRecordBranchFreshness, {
				issueNumber: JOURNEY_ISSUE,
				freshness: 'synced',
			}),
		recordRepro: () =>
			call(executeRecordIssueReproduction, {
				issueNumber: JOURNEY_ISSUE,
				performed: true,
				commands: ['bun repro/C1.mjs'],
				output_summary:
					'pre-fix check fails closed on the missing freshness surface',
			}),
		recordReview: () =>
			call(executeRecordImplementationReview, {
				issueNumber: JOURNEY_ISSUE,
				reviewerVerdict: 'APPROVE',
				criticVerdict: 'APPROVE',
				diffBase: 'b865ba262f',
				diffHead: PR_HEAD,
				notes: 'fresh reviewer and fresh critic both approved',
			}),
		recordSweep: () =>
			call(executeRecordRecurrenceSweep, {
				issueNumber: JOURNEY_ISSUE,
				defectClass: 'no defect class',
				justification: 'receipt wiring corrects no incorrect behavior',
				relatedProblems: [{ ref: '#2600', note: 'coordinated, not absorbed' }],
			}),
		recordValidation: () =>
			call(executeRecordTraceValidation, {
				issueNumber: JOURNEY_ISSUE,
				phase: '4.6',
				outcome: 'pass',
				reviewedCommit: PR_HEAD,
				treeId: TREE_ID,
			}),
		recordPublication: () =>
			call(executeRecordIssuePublication, {
				issueNumber: JOURNEY_ISSUE,
				prNumber: 4321,
				prUrl: 'https://github.com/ZaxbyHub/opencode-swarm/pull/4321',
				headSha: PR_HEAD,
			}),
		recordMergeApproval: () =>
			call(executeRecordMergeApproval, {
				issueNumber: JOURNEY_ISSUE,
				prHeadSha: PR_HEAD,
				finalCriticReviewedCommit: PR_HEAD,
				userApprovalVerbatim:
					'User approved merging PR #4321 after the final critic report',
			}),
		resetCaches: () => {
			resetApprovalCache();
			resetPhaseStatusCache();
		},
		cleanup: () => {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		},
	};
}

export { handleIssueCommand, loadPlan };
