/**
 * Shared fixtures for the issue #2600 plan-binding regression suites
 * (reducer file + hook/command/journey file). Not a test file (FR-006 caps
 * only *.test.ts); bun:test is imported only to register the seam/cache
 * reset hook.
 */

import { afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	createIssueTraceHook,
	_internals as hookInternals,
	resetApprovalCache,
	resetPhaseStatusCache,
} from '../../../src/hooks/issue-trace';
import {
	computeNextMode,
	type IssueReference,
	type TraceState,
	type WorkflowArtifacts,
} from '../../../src/hooks/issue-trace-reducer';
import { computeSpecHash } from '../../../src/utils/spec-hash';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

export {
	createIssueTraceHook,
	hookInternals,
	resetApprovalCache,
	resetPhaseStatusCache,
};

export function makeRef(number = 42): IssueReference {
	return {
		url: `https://github.com/owner/repo/issues/${number}`,
		owner: 'owner',
		repo: 'repo',
		number,
		timestamp: '2026-01-01T00:00:00Z',
		flags: { trace: true },
	};
}

export function makeTrace(over: Partial<TraceState> = {}): TraceState {
	return {
		issueNumber: 42,
		lastTransition: null,
		status: 'in_progress',
		...over,
	};
}

export function makeArt(
	over: Partial<WorkflowArtifacts> = {},
): WorkflowArtifacts {
	return {
		specExists: true,
		specIssueNumber: 42,
		planExists: true,
		criticApproved: true,
		allPhasesComplete: false,
		reproductionPermitted: true,
		freshnessPermitted: true,
		publicationObserved: false,
		recurrenceSweepVerified: false,
		implementationReviewVerified: false,
		traceValidationVerified: false,
		mergeApprovalObserved: false,
		planBoundToSpec: true,
		...over,
	};
}

export function call(
	ref: IssueReference,
	trace: TraceState,
	art: Partial<WorkflowArtifacts> = {},
) {
	return computeNextMode({
		issueReference: ref,
		traceState: trace,
		workflowArtifacts: makeArt(art),
	});
}

export const sha = (s: string) =>
	createHash('sha256').update(s, 'utf-8').digest('hex');

/** A schema-valid plan shape; specHash configurable to simulate binding. */
function planJson(specHash?: string): Record<string, unknown> {
	return {
		schema_version: '1.0.0',
		title: 'Plan under trace',
		swarm: 'local',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implement',
				status: 'pending',
				tasks: [],
			},
		],
		...(specHash !== undefined ? { specHash } : {}),
	};
}

/**
 * Seeds a hook scenario: spec + reference + state, plus a plan unless
 * `planSpecHash === null`. `'auto'` records the current spec's real hash
 * (what save_plan captures); any other string simulates a foreign spec;
 * `undefined` writes a plan with no spec linkage.
 */
export async function seedDir(
	over: {
		specNumber?: number;
		planSpecHash?: string | null;
		noReproWaiver?: boolean;
	} = {},
): Promise<string> {
	const dir = canonicalMkdtemp('issue-trace-binding-2600-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.swarm', 'spec.md'),
		`# Spec\n\n## Source Issue\n\n- Number: ${over.specNumber ?? 42}\n\n## Details\n`,
		'utf-8',
	);
	if (over.planSpecHash !== null) {
		const specHash =
			over.planSpecHash === 'auto'
				? ((await computeSpecHash(dir)) ?? undefined)
				: over.planSpecHash;
		fs.writeFileSync(
			path.join(dir, '.swarm', 'plan.json'),
			JSON.stringify(planJson(specHash), null, 2),
			'utf-8',
		);
	}
	const reference = over.noReproWaiver
		? {
				...makeRef(),
				flags: { trace: true, noRepro: true },
				noReproWaiver: {
					waived: true,
					reason: '--no-repro flag',
					timestamp: '2026-01-01T00:00:00Z',
				},
			}
		: makeRef();
	fs.writeFileSync(
		path.join(dir, '.swarm', 'issue-reference.json'),
		JSON.stringify(reference, null, 2),
		'utf-8',
	);
	fs.writeFileSync(
		path.join(dir, '.swarm', 'issue-trace-state.json'),
		JSON.stringify(makeTrace(), null, 2),
		'utf-8',
	);
	return dir;
}

const hookOriginals = { ...hookInternals };
afterEach(() => {
	Object.assign(hookInternals, hookOriginals);
	resetApprovalCache();
	resetPhaseStatusCache();
});

export async function runHook(dir: string): Promise<{ messages: unknown[] }> {
	const output = { messages: [] as unknown[] };
	await createIssueTraceHook({}, dir, 100).messagesTransform({}, output);
	return output;
}

export function readState(dir: string): TraceState | null {
	try {
		return JSON.parse(
			fs.readFileSync(
				path.join(dir, '.swarm', 'issue-trace-state.json'),
				'utf-8',
			),
		) as TraceState;
	} catch {
		return null;
	}
}
