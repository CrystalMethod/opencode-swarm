/**
 * Tests for Epic Mode banner constants + hasActiveEpicMode wiring.
 * File: tests/unit/hooks/system-enhancer-epic-banner.test.ts
 *
 * The full system-enhancer prompt-injection flow is heavy integration
 * machinery; this test covers the leaf-level invariants the
 * `if (hasActiveEpicMode(...)) inject(EPIC_MODE_BANNER)` block relies
 * on:
 *
 *   - `EPIC_MODE_BANNER` exists and instructs the architect to use the
 *     visible decide → plan-waves → Task flow instead of
 *     `lean_turbo_run_phase`, with per-task Stage A/B and the
 *     `epic_phase_review` phase gate.
 *   - `hasActiveEpicMode(sessionID)` reads `session.epicModeActive`
 *     and returns the expected booleans (per-session and any-session).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EPIC_MODE_BANNER } from '../../../src/config/constants';
import { estimateTokens } from '../../../src/hooks/utils';
import {
	hasActiveEpicMode,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';

beforeEach(() => {
	resetSwarmState();
});

afterEach(() => {
	resetSwarmState();
});

describe('EPIC_MODE_BANNER content', () => {
	test('describes the SINGLE sanctioned phase-execution flow', () => {
		// The banner describes ONE flow:
		//   declare_scope → epic_decide_phase → epic_plan_waves
		//     → Task dispatch (per wave) → epic_record_divergence
		// All five tool names appear; the opaque alternatives are
		// explicitly forbidden. 2026-06-05 compression: text was condensed
		// to fit the 4000-token injection budget — assert semantic anchors,
		// not verbatim prose.
		expect(EPIC_MODE_BANNER).toContain('declare_scope');
		expect(EPIC_MODE_BANNER).toContain('epic_decide_phase');
		expect(EPIC_MODE_BANNER).toContain('epic_plan_waves');
		expect(EPIC_MODE_BANNER).toContain('Task');
		expect(EPIC_MODE_BANNER).toContain('epic_record_divergence');
		expect(EPIC_MODE_BANNER).toContain('Seven-step flow');
		expect(EPIC_MODE_BANNER).not.toContain('Six-step flow');
	});

	test('forbids the opaque lean_turbo_run_phase dispatch and no longer names the removed epic_run_phase', () => {
		// lean_turbo_run_phase dispatches coders via opencodeClient internally
		// (outside opencode's Task tracking). The banner must block it so the
		// transparent Task-based dispatch is the only flow the architect can
		// take.
		expect(EPIC_MODE_BANNER).toContain(
			'Do NOT call `lean_turbo_run_phase` directly',
		);
		expect(EPIC_MODE_BANNER).toContain("Don't use `lean_turbo_run_phase`");
		// The legacy epic_run_phase execution path was removed outright, so the
		// banner must not advertise it (even as "deprecated").
		expect(EPIC_MODE_BANNER).not.toContain('epic_run_phase');
	});

	test('step 6 requires per-task Stage A/B before completion + divergence', () => {
		// Runtime truth: update_task_status(completed) requires Stage B in every
		// mode (Turbo/Lean bypass branches are legacy-caller-only). The banner
		// previously said Epic "doesn't change Stage B" without ever telling
		// the architect to run it between dispatch and completion.
		const step6 = EPIC_MODE_BANNER.slice(
			EPIC_MODE_BANNER.indexOf('**6. '),
			EPIC_MODE_BANNER.indexOf('**7. '),
		);
		expect(step6).toContain('`pre_check_batch`');
		expect(step6).toContain('`reviewer` + `test_engineer`');
		expect(step6).toContain('never skipped');
		expect(step6.indexOf('pre_check_batch')).toBeLessThan(
			step6.indexOf('update_task_status(completed)'),
		);
		expect(step6.indexOf('update_task_status(completed)')).toBeLessThan(
			step6.indexOf('epic_record_divergence'),
		);
	});

	test('step 7 routes phase completion through epic_phase_review', () => {
		const step7 = EPIC_MODE_BANNER.slice(EPIC_MODE_BANNER.indexOf('**7. '));
		expect(step7).toContain('`epic_phase_review(phase=N)`');
		expect(step7).toContain('phase critic');
		expect(step7).toContain('`EPIC_PHASE_*`');
		expect(step7.indexOf('epic_phase_review')).toBeLessThan(
			step7.lastIndexOf('`phase_complete`'),
		);
		expect(EPIC_MODE_BANNER).not.toContain("doesn't change Stage B");
	});

	test('step 2 explains scope expiry and the config opt-in reason', () => {
		const step2 = EPIC_MODE_BANNER.slice(
			EPIC_MODE_BANNER.indexOf('**2. '),
			EPIC_MODE_BANNER.indexOf('**3. '),
		);
		expect(step2).toContain('`scopes-missing`');
		expect(step2).toContain('expired');
		expect(step2).toContain('plan revised');
		expect(step2).toContain('`epic-disabled-by-config`');
		expect(step2).toContain('turbo.epic.mode.enabled: true');
	});

	test('step 1: re-declare needs replace_existing; a phase advance voids bindings (declare per phase)', () => {
		const step1 = EPIC_MODE_BANNER.slice(
			EPIC_MODE_BANNER.indexOf('**1. '),
			EPIC_MODE_BANNER.indexOf('**2. '),
		);
		expect(step1).toContain('every pending task of phase N');
		expect(step1).toContain('start of EVERY phase');
		expect(step1).toContain('replace_existing: true');
		expect(step1).toContain('phase advance');
	});

	test('stays within the pre-catch-up injection budget (≤ 1994 tokens)', () => {
		// The banner competes for the system-enhancer injection budget; the
		// catch-up additions (steps 6/7) were paid for by tightening prose.
		expect(estimateTokens(EPIC_MODE_BANNER)).toBeLessThanOrEqual(1994);
	});

	test('explains both promote and demote outcomes', () => {
		expect(EPIC_MODE_BANNER).toContain('promote');
		expect(EPIC_MODE_BANNER).toContain('demote');
	});

	test('preserves the Stage B / phase-reviewer requirement', () => {
		expect(EPIC_MODE_BANNER.toLowerCase()).toContain('phase reviewer');
	});

	test('puts a user-interrupt-priority rule FIRST, overriding the protocol', () => {
		// Live failure (Kimi K2.6, Phase 3, 2026-06-05): mid-phase, the
		// architect tunnel-visioned on a coder retry loop and ignored direct
		// user messages — even an explicit `/swarm epic status` slash
		// command. Root cause: nothing told it user input overrides the
		// flow, and the protocol banner is re-injected every turn. This rule
		// is the antidote and MUST appear before the six-step flow so it
		// outranks it.
		expect(EPIC_MODE_BANNER).toContain('THE USER ALWAYS COMES FIRST');
		expect(EPIC_MODE_BANNER).toContain('STOP advancing the flow');
		expect(EPIC_MODE_BANNER.toLowerCase()).toContain('slash command');
		// It must come BEFORE the step-flow header to outrank it.
		expect(
			EPIC_MODE_BANNER.indexOf('THE USER ALWAYS COMES FIRST'),
		).toBeLessThan(EPIC_MODE_BANNER.indexOf('Seven-step flow'));
	});

	test('asks the architect to tell the user the verdict and wave plan', () => {
		// Without this, weaker models (Kimi K2.6 observed) dispatched
		// silently and the user had no signal Epic was doing anything.
		// The 2026-06-05 v2 wording dropped the heavy "MANDATORY SURFACE /
		// copy VERBATIM" compliance scaffolding (which made the architect
		// robotic) in favor of a natural "tell the user … in your own
		// words" nudge for BOTH the verdict and the wave plan.
		// 2026-06-05 v3: reverted to the 06-03 plain "surface immediately"
		// phrasing that empirically worked, after the MANDATORY/VERBATIM
		// surface-block cascade (622aa1da etc.) regressed natural talking.
		expect(EPIC_MODE_BANNER).toContain(
			'Surface the verdict to the user immediately',
		);
		expect(EPIC_MODE_BANNER).toContain('Surface the wave plan to the user');
		// Natural narration is still framed as conversation, not a script.
		expect(EPIC_MODE_BANNER).toContain('in your own words');
		expect(EPIC_MODE_BANNER).toContain('in your own voice');
		// The robotic-era scaffolding must be gone — no MANDATORY SURFACE and
		// no "copy VERBATIM" surface-block phrasing (those tool-result
		// functions were deleted). NOTE: a legitimate "surface its output
		// VERBATIM" remains on the slash-command line (echo status output) —
		// that's not the robotic phrasing, so we target the specific strings.
		expect(EPIC_MODE_BANNER).not.toContain('MANDATORY SURFACE');
		expect(EPIC_MODE_BANNER).not.toContain('copy them VERBATIM');
		expect(EPIC_MODE_BANNER).not.toContain('COPIED VERBATIM');
	});

	test('lists the /swarm epic visibility commands', () => {
		// After 2026-06-05 compression these are listed as a single
		// pipe-joined line for token efficiency, not four separate lines.
		expect(EPIC_MODE_BANNER).toContain('/swarm epic status');
		expect(EPIC_MODE_BANNER).toContain('last');
		expect(EPIC_MODE_BANNER).toContain('decide');
		expect(EPIC_MODE_BANNER).toContain('calibration');
	});

	test('mandates surfacing divergence when a task wrote outside its declared scope', () => {
		// Without this, per-task divergence is silent — the user only sees
		// the activation decision, not the scope-discipline signal that
		// drives the next threshold tightening.
		expect(EPIC_MODE_BANNER).toContain('summary.isClean: false');
		expect(EPIC_MODE_BANNER).toContain('Divergence: task');
	});

	test('mandates declaring scope upfront BEFORE the decision call', () => {
		// Discovered live: without upfront scope declaration the wave
		// planner has no graph and falls back to serial dispatch silently.
		// After 2026-06-05 compression the rule is expressed compactly:
		// "declare ALL pending scopes UP FRONT (step 1), BEFORE step 2."
		expect(EPIC_MODE_BANNER).toContain('declare_scope');
		expect(EPIC_MODE_BANNER).toContain('UP FRONT');
		expect(EPIC_MODE_BANNER).toContain('BEFORE step 2');
		// Supersedes Rule 1a/3a's declare-as-you-go cadence.
		expect(EPIC_MODE_BANNER).toContain('Just-in-time declaration');
	});

	test('mandates Task dispatch (with all calls in ONE message per wave for parallel execution)', () => {
		// The point of the architect-led dispatch is opencode-tracked
		// subagents the user can click into for live visibility. Each wave
		// is one assistant message containing wave.taskIds.length separate
		// Task calls. After 2026-06-05 compression these are stated as
		// "SEPARATE Task calls in ONE assistant message".
		expect(EPIC_MODE_BANNER).toContain(
			'SEPARATE `Task` calls in ONE assistant message',
		);
		expect(EPIC_MODE_BANNER).toContain('subagent_type="coder"');
		expect(EPIC_MODE_BANNER).toContain('only sanctioned dispatch path');
		// Defects-to-avoid block must call out bundling and splitting
		// explicitly (these were observed live failure modes).
		expect(EPIC_MODE_BANNER).toContain('Bundling');
		expect(EPIC_MODE_BANNER).toContain('Splitting across messages');
		expect(EPIC_MODE_BANNER).toContain('Skipping single-task waves');
	});
});

describe('hasActiveEpicMode — per-session lookup', () => {
	test('returns false when no session exists', () => {
		expect(hasActiveEpicMode('non-existent')).toBe(false);
	});

	test('returns false for a session without epicModeActive set', () => {
		startAgentSession('sess-a', 'architect');
		expect(hasActiveEpicMode('sess-a')).toBe(false);
	});

	test('returns true when epicModeActive is explicitly set', () => {
		startAgentSession('sess-a', 'architect');
		const session = swarmState.agentSessions.get('sess-a');
		if (!session) throw new Error('session not found');
		session.epicModeActive = true;
		expect(hasActiveEpicMode('sess-a')).toBe(true);
	});

	test('returns false after the flag is cleared', () => {
		startAgentSession('sess-a', 'architect');
		const session = swarmState.agentSessions.get('sess-a');
		if (!session) throw new Error('session not found');
		session.epicModeActive = true;
		session.epicModeActive = false;
		expect(hasActiveEpicMode('sess-a')).toBe(false);
	});
});

describe('hasActiveEpicMode — global (any-session) lookup', () => {
	test('returns false when no sessions exist', () => {
		expect(hasActiveEpicMode()).toBe(false);
	});

	test('returns true if ANY session has it active', () => {
		startAgentSession('sess-a', 'architect');
		startAgentSession('sess-b', 'architect');
		const sb = swarmState.agentSessions.get('sess-b');
		if (!sb) throw new Error('session not found');
		sb.epicModeActive = true;
		expect(hasActiveEpicMode()).toBe(true);
	});

	test('returns false when no session has it active', () => {
		startAgentSession('sess-a', 'architect');
		startAgentSession('sess-b', 'architect');
		expect(hasActiveEpicMode()).toBe(false);
	});
});
