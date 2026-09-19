/**
 * Regression suite for issue #2600: bind the issue trace to its loaded plan
 * and surface silent trace stalls. Covers the four new one-shot gates
 * (SPEC_MISMATCH_GATE, PLAN_BINDING_GATE, REPRO_GATE_LATE, CRITIC_GATE) at
 * the reducer level, the binding + one-shot directives at the real-hook level
 * (real files on disk; only the approval input is seam-injected — the
 * delegated-truth pattern), the non-trace state hygiene in handleIssueCommand,
 * and the foreign-plan leg through the real journey machinery. The frozen
 * acceptance checks C1-C3/C6 pin the same contracts end to end; this file is
 * the in-repo regression surface. Under 500 lines (FR-006).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleIssueCommand } from '../../../src/commands/issue';
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
import { createJourneyProject } from './issue-trace-journey-v3-helpers';

// ── Fixtures ────────────────────────────────────────────────────────

function makeRef(number = 42): IssueReference {
	return {
		url: `https://github.com/owner/repo/issues/${number}`,
		owner: 'owner',
		repo: 'repo',
		number,
		timestamp: '2026-01-01T00:00:00Z',
		flags: { trace: true },
	};
}

function makeTrace(over: Partial<TraceState> = {}): TraceState {
	return {
		issueNumber: 42,
		lastTransition: null,
		status: 'in_progress',
		...over,
	};
}

function makeArt(over: Partial<WorkflowArtifacts> = {}): WorkflowArtifacts {
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

function call(
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

const sha = (s: string) =>
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
async function seedDir(
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

async function runHook(dir: string): Promise<{ messages: unknown[] }> {
	const output = { messages: [] as unknown[] };
	await createIssueTraceHook({}, dir, 100).messagesTransform({}, output);
	return output;
}

function readState(dir: string): TraceState | null {
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

// ── Reducer: plan binding gate (AC1) ────────────────────────────────

describe('issue #2600 — plan binding gate (reducer)', () => {
	test('a foreign plan (planBoundToSpec false) never reaches EXECUTE and emits a one-shot directive', () => {
		const r = call(makeRef(), makeTrace(), {
			planBoundToSpec: false,
			criticApproved: true,
			allPhasesComplete: false,
		});
		expect(r.nextMode).not.toBe('EXECUTE');
		expect(r.directive).not.toBeNull();
		expect(r.directive).toMatch(/plan/i);
		expect(r.directive).toMatch(/bind|bound|mismatch|foreign|spec/i);
		expect(r.nextLastTransition).toBe('PLAN_BINDING_GATE');
	});

	test('binding gate is one-shot: quiet after the sentinel fires', () => {
		const r = call(
			makeRef(),
			makeTrace({ lastTransition: 'PLAN_BINDING_GATE' }),
			{ planBoundToSpec: false },
		);
		expect(r.nextMode).toBeNull();
		expect(r.directive).toBeNull();
	});

	test('binding gate fires from the fresh-trace and pre-plan sentinels', () => {
		for (const lastTransition of [
			null,
			'SPEC_MISMATCH_GATE',
			'FRESHNESS_GATE',
			'REPRO_GATE',
			'ISSUE_INGEST_TO_PLAN',
		]) {
			const r = call(makeRef(), makeTrace({ lastTransition }), {
				planBoundToSpec: false,
			});
			expect(r.nextLastTransition).toBe('PLAN_BINDING_GATE');
		}
	});

	test('binding gate re-arms from the post-plan sentinels (mid-flight spec edit re-nudges)', () => {
		// Review pr2837-r1 F6: a spec edited while the trace is parked at a
		// later gate must re-nudge (unbound plan), not stall silently behind
		// the exhausted pre-plan sentinels. The guard's own-sentinel exclusion
		// keeps each nudge one-shot; the hard `return noop` still guarantees
		// rows (g-repro)/(g)/(h) never drive an unbound plan. The
		// allPhasesComplete=true leg also pins the publication-ladder swallow
		// class: an unbound COMPLETED plan re-nudges instead of silently
		// no-opping the REVIEW_GATE/EXECUTE_TO_COMMIT directives the
		// post-completion rows would otherwise emit.
		for (const allPhasesComplete of [false, true]) {
			for (const lastTransition of [
				'REPRO_GATE_LATE',
				'CRITIC_GATE',
				'PLAN_TO_EXECUTE',
				'REVIEW_GATE',
				'EXECUTE_TO_COMMIT',
			]) {
				const r = call(makeRef(), makeTrace({ lastTransition }), {
					planBoundToSpec: false,
					criticApproved: true,
					reproductionPermitted: true,
					allPhasesComplete,
				});
				expect(r.nextMode).not.toBe('EXECUTE');
				expect(r.nextLastTransition).toBe('PLAN_BINDING_GATE');
			}
		}
	});

	test('recovery chain: park → plan corrected → repro → critic → EXECUTE', () => {
		// Review pr2837-r1 F7: the documented recovery (re-save the plan)
		// actually re-drives the ladder. Every hop is driven by the reducer
		// from the previous hop's sentinel.
		const parked = call(makeRef(), makeTrace(), { planBoundToSpec: false });
		expect(parked.nextLastTransition).toBe('PLAN_BINDING_GATE');

		const repro = call(
			makeRef(),
			makeTrace({ lastTransition: parked.nextLastTransition }),
			{ planBoundToSpec: true, reproductionPermitted: false },
		);
		expect(repro.nextLastTransition).toBe('REPRO_GATE_LATE');

		const critic = call(
			makeRef(),
			makeTrace({ lastTransition: repro.nextLastTransition }),
			{
				planBoundToSpec: true,
				reproductionPermitted: true,
				criticApproved: false,
			},
		);
		expect(critic.nextLastTransition).toBe('CRITIC_GATE');

		const execute = call(
			makeRef(),
			makeTrace({ lastTransition: critic.nextLastTransition }),
			{
				planBoundToSpec: true,
				reproductionPermitted: true,
				criticApproved: true,
			},
		);
		expect(execute.nextMode).toBe('EXECUTE');
		expect(execute.nextLastTransition).toBe('PLAN_TO_EXECUTE');
	});

	test('undefined planBoundToSpec stays transparent (legacy v2-shaped literals)', () => {
		// A legacy caller that omits the field must not park: the reducer
		// treats only explicit false as a binding failure (the
		// freshnessPermitted/traceValidationVerified convention).
		const r = computeNextMode({
			issueReference: makeRef(),
			traceState: makeTrace(),
			workflowArtifacts: {
				specExists: true,
				specIssueNumber: 42,
				planExists: true,
				criticApproved: true,
				allPhasesComplete: false,
				reproductionPermitted: true,
				publicationObserved: false,
				recurrenceSweepVerified: false,
				implementationReviewVerified: false,
				traceValidationVerified: false,
				mergeApprovalObserved: false,
			},
		});
		expect(r.nextMode).toBe('EXECUTE');
	});

	test('a bound plan still proceeds to EXECUTE when approved', () => {
		const r = call(makeRef(), makeTrace(), { planBoundToSpec: true });
		expect(r.nextMode).toBe('EXECUTE');
		expect(r.nextLastTransition).toBe('PLAN_TO_EXECUTE');
	});
});

// ── Reducer: reproduction gate reachable with an existing plan (AC6) ──

describe('issue #2600 — reproduction gate with an existing plan (reducer)', () => {
	test('bound plan without reproduction evidence parks with a one-shot directive, not EXECUTE', () => {
		const r = call(makeRef(), makeTrace(), {
			planBoundToSpec: true,
			reproductionPermitted: false,
			criticApproved: true,
		});
		expect(r.nextMode).not.toBe('EXECUTE');
		expect(r.directive).toContain('record_issue_reproduction');
		expect(r.directive).toContain('--no-repro');
		expect(r.nextLastTransition).toBe('REPRO_GATE_LATE');
	});

	test('REPRO_GATE_LATE is one-shot and chains into the critic gate', () => {
		const quiet = call(
			makeRef(),
			makeTrace({ lastTransition: 'REPRO_GATE_LATE' }),
			{ reproductionPermitted: false },
		);
		expect(quiet.directive).toBeNull();

		const chained = call(
			makeRef(),
			makeTrace({ lastTransition: 'REPRO_GATE_LATE' }),
			{ reproductionPermitted: true, criticApproved: false },
		);
		expect(chained.nextLastTransition).toBe('CRITIC_GATE');
	});
});

// ── Reducer: critic gate one-shot (AC2) ─────────────────────────────

describe('issue #2600 — critic gate directive (reducer)', () => {
	test('critic-not-approved surfaces approve_plan_critic exactly once', () => {
		const r = call(makeRef(), makeTrace(), { criticApproved: false });
		expect(r.nextMode).toBe('CRITIC-GATE');
		expect(r.directive).toContain('approve_plan_critic');
		expect(r.nextLastTransition).toBe('CRITIC_GATE');

		const quiet = call(
			makeRef(),
			makeTrace({ lastTransition: 'CRITIC_GATE' }),
			{ criticApproved: false },
		);
		expect(quiet.directive).toBeNull();
	});

	test('spec mismatch surfaces exactly once (row d)', () => {
		const r = call(makeRef(), makeTrace(), { specIssueNumber: 41 });
		expect(r.nextMode).toBe('ISSUE_INGEST');
		expect(r.nextLastTransition).toBe('SPEC_MISMATCH_GATE');
		expect(r.directive).toMatch(/spec/i);
		expect(r.directive).toMatch(/issue/i);

		const quiet = call(
			makeRef(),
			makeTrace({ lastTransition: 'SPEC_MISMATCH_GATE' }),
			{ specIssueNumber: 41 },
		);
		expect(quiet.directive).toBeNull();
	});
});

// ── Hook: foreign plan through the real engine (AC1, hook leg) ──────

describe('issue #2600 — hook-level one-shot directives (spec mismatch / timeout)', () => {
	test('cross-issue spec mismatch surfaces a ONE-SHOT directive, then waits quietly', async () => {
		const dir = await seedDir({ specNumber: 99, planSpecHash: null });
		const { messages } = await runHook(dir);
		expect(messages).toHaveLength(2);
		expect(readState(dir)?.lastTransition).toBe('SPEC_MISMATCH_GATE');

		// Second drive: already nudged once → silent noop.
		const second = await runHook(dir);
		expect(second.messages).toHaveLength(0);
	});

	test('trace-state issueNumber mismatch surfaces the same one-shot directive', async () => {
		const dir = await seedDir({ planSpecHash: null });
		fs.writeFileSync(
			path.join(dir, '.swarm', 'issue-trace-state.json'),
			JSON.stringify(makeTrace({ issueNumber: 99 }), null, 2),
			'utf-8',
		);
		const { messages } = await runHook(dir);
		expect(messages).toHaveLength(2);
		expect(readState(dir)?.lastTransition).toBe('SPEC_MISMATCH_GATE');
	});

	test('timeout: approval slower than the bound → fail-closed after timeout, CRITIC_GATE surfaces', async () => {
		// A bound plan with an incomplete phase (real plan.json on disk) and a
		// typed --no-repro waiver: row g (critic pending) is what applies. The
		// seam resolves TRUE only well past the hook's 100 ms bound, so the
		// outcome is genuinely timeout-dependent (review pr2837-r1 F4): if the
		// bounded-approval timeout ever regressed and the hook awaited the late
		// promise, criticApproved would flip to true, row (h) would advance the
		// trace to PLAN_TO_EXECUTE, and BOTH assertions below would fail. A
		// never-resolving seam cannot discriminate that way — the real loader
		// also returns false fast on this seed, so the old shape passed even
		// with the timeout removed.
		const dir = await seedDir({ planSpecHash: 'auto', noReproWaiver: true });
		hookInternals.isPlanCriticApproved = () =>
			new Promise<boolean>((resolve) => {
				setTimeout(() => resolve(true), 250);
			});

		const { messages } = await runHook(dir);
		expect(messages).toHaveLength(2);
		expect(readState(dir)?.lastTransition).toBe('CRITIC_GATE');
	});
});

describe('issue #2600 — plan binding gate (hook, real files)', () => {
	test('a critic-approved plan whose specHash belongs to another spec parks the trace (never EXECUTE)', async () => {
		// hash of a DIFFERENT spec — the pre-overwrite spec of another issue
		const dir = await seedDir({
			planSpecHash: sha('# Spec\n\n## Source Issue\n\n- Number: 41\n'),
		});
		hookInternals.isPlanCriticApproved = () => Promise.resolve(true);

		const { messages } = await runHook(dir);
		const text = JSON.stringify(messages);
		expect(text).not.toContain('[MODE: EXECUTE]');
		expect(text).toMatch(/bind|bound|mismatch|foreign|spec/i);
		expect(readState(dir)?.lastTransition).toBe('PLAN_BINDING_GATE');
	});

	test('a bound plan with approval and reproduction proceeds to EXECUTE', async () => {
		const dir = await seedDir({ planSpecHash: 'auto', noReproWaiver: true });
		hookInternals.isPlanCriticApproved = () => Promise.resolve(true);

		const { messages } = await runHook(dir);
		expect(JSON.stringify(messages)).toContain('[MODE: EXECUTE]');
		expect(readState(dir)?.lastTransition).toBe('PLAN_TO_EXECUTE');
	});

	test('a plan with no recorded specHash under an active trace fails closed', async () => {
		const dir = await seedDir({});
		hookInternals.isPlanCriticApproved = () => Promise.resolve(true);

		const { messages } = await runHook(dir);
		const text = JSON.stringify(messages);
		expect(text).not.toContain('[MODE: EXECUTE]');
		expect(readState(dir)?.lastTransition).toBe('PLAN_BINDING_GATE');
	});
});

// ── Command: non-trace state hygiene (AC3) ──────────────────────────

describe('issue #2600 — non-trace invocation leaves no in_progress trace state', () => {
	let dir: string;
	beforeEach(() => {
		dir = canonicalMkdtemp('issue-cmd-2600-');
		fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /nonexistent\n', 'utf-8');
	});

	test('no flags → issue-reference.json only, no trace-state file', () => {
		const result = handleIssueCommand(dir, [
			'https://github.com/owner/repo/issues/42',
		]);
		expect(result).toContain('[MODE: ISSUE_INGEST');
		expect(
			fs.existsSync(path.join(dir, '.swarm', 'issue-reference.json')),
		).toBe(true);
		expect(
			fs.existsSync(path.join(dir, '.swarm', 'issue-trace-state.json')),
		).toBe(false);
	});

	test('pre-existing trace-state is left byte-identical by a non-trace invocation', () => {
		const seeded = JSON.stringify(
			{
				issueNumber: 7,
				lastTransition: 'PLAN_TO_EXECUTE',
				status: 'in_progress',
			},
			null,
			2,
		);
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.swarm', 'issue-trace-state.json'),
			seeded,
			'utf-8',
		);
		handleIssueCommand(dir, ['https://github.com/owner/repo/issues/42']);
		expect(
			fs.readFileSync(
				path.join(dir, '.swarm', 'issue-trace-state.json'),
				'utf-8',
			),
		).toBe(seeded);
	});

	test('--trace still persists the in_progress trace state', () => {
		handleIssueCommand(dir, [
			'https://github.com/owner/repo/issues/43',
			'--trace',
		]);
		const state = readState(dir);
		expect(state?.issueNumber).toBe(43);
		expect(state?.status).toBe('in_progress');
	});
});

// ── Journey: foreign plan through the real machinery (AC1, journey leg) ──

describe('issue #2600 — foreign plan through the real journey machinery', () => {
	let project: ReturnType<typeof createJourneyProject> | null = null;
	afterEach(() => {
		project?.cleanup();
		project = null;
	});

	test('a plan saved against a different spec parks the real trace at PLAN_BINDING_GATE', async () => {
		project = createJourneyProject();
		handleIssueCommand(project.dir, [
			'ZaxbyHub/opencode-swarm#2564',
			'--trace',
		]);
		project.writeSpec();
		await project.recordFreshness();
		await project.recordRepro();
		await project.cycle(); // ISSUE_INGEST_TO_PLAN

		// Save the journey plan, then REWRITE the spec — the plan's recorded
		// specHash now belongs to the old spec, exactly the #2600 wedge.
		await project.saveJourneyPlan('in_progress', 'in_progress');
		const specPath = path.join(project.dir, '.swarm', 'spec.md');
		fs.writeFileSync(
			specPath,
			'# Spec\n\n## Source Issue\n\n- Number: 2564\n\n## Details\n\nCHANGED requirements.\n',
			'utf-8',
		);
		project.resetCaches();

		const step = await project.cycle();
		expect(step.state.lastTransition).toBe('PLAN_BINDING_GATE');
		expect(step.text).toMatch(/bind|bound|mismatch|foreign|spec/i);
	});
});
