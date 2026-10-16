/**
 * AC14 (issue #3310) — PR critic dispatch names exactly one PR critic agent,
 * and that agent's system prompt carries a PR-contract override.
 *
 * SKILL.md's critic-dispatch instruction (~:1265, the paragraph that carries
 * `swarm-pr-review:critic` mode and `review_item_ids`) currently says only
 * "critic-role agents only" and names NO specific agent. The fix names
 * EXACTLY ONE PR critic agent — the base `critic` agent — and never
 * `critic_finding_validator` (whose builder emits a strict-JSON prompt, not
 * `[CRITIC]` rows). The base critic prompt (createCriticAgent, plan_critic
 * role) gains an additive PR-contract override: when a
 * "CONTROLLER-BOUND PR WORKFLOW CONTRACT" block is present in the prompt,
 * the default output structure is suspended and only `[CRITIC]` rows are
 * emitted.
 *
 * RED at base (named-agent and override legs), GREEN after the fix.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCriticAgent } from '../../../src/agents/critic.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILL_PATH = join(
	__dirname,
	'../../../.opencode/skills/swarm-pr-review/SKILL.md',
);

const PR_CONTRACT_BLOCK = 'CONTROLLER-BOUND PR WORKFLOW CONTRACT';

/**
 * The critic-dispatch instruction: the SKILL.md paragraph that carries both
 * the `swarm-pr-review:critic` mode and `review_item_ids` (the Phase 8
 * dispatch paragraph). `review_item_ids` discriminates it from the
 * dispatch-mode namespace table and the COVERAGE GATE alignment paragraph,
 * which mention the mode string but never the item IDs.
 */
function criticDispatchParagraph(skill: string): string | undefined {
	return skill
		.split(/\n\s*\n/)
		.find(
			(paragraph) =>
				paragraph.includes('swarm-pr-review:critic') &&
				paragraph.includes('review_item_ids'),
		);
}

function defaultCriticPrompt(): string {
	const agent = createCriticAgent('test-model');
	return agent.config.prompt;
}

describe('critic PR-contract override (AC14, issue #3310)', () => {
	test('SKILL.md critic dispatch names exactly the base `critic` agent', () => {
		const paragraph = criticDispatchParagraph(
			readFileSync(SKILL_PATH, 'utf-8'),
		);
		expect(paragraph).toBeDefined();
		expect(paragraph ?? '').toMatch(/`critic`/);
	});

	test('SKILL.md critic dispatch never names critic_finding_validator or the phase verifiers', () => {
		const paragraph = criticDispatchParagraph(
			readFileSync(SKILL_PATH, 'utf-8'),
		);
		expect(paragraph).toBeDefined();
		expect(paragraph ?? '').not.toMatch(/critic_finding_validator/);
		expect(paragraph ?? '').not.toMatch(
			/critic_drift_verifier|critic_hallucination_verifier/,
		);
	});

	test('default critic prompt carries the CONTROLLER-BOUND PR WORKFLOW CONTRACT override clause', () => {
		const prompt = defaultCriticPrompt();
		const idx = prompt.indexOf(PR_CONTRACT_BLOCK);
		expect(idx).toBeGreaterThanOrEqual(0);
		const clause = idx >= 0 ? prompt.slice(idx, idx + 800) : '';
		// the clause must suspend the default output structure ...
		expect(clause).toMatch(/suspend|does not apply/i);
		// ... and emit only [CRITIC] rows under the contract
		expect(clause).toMatch(/\[CRITIC\]/);
	});

	test('override is additive: the PLAN REVIEW default structure mandate survives', () => {
		expect(defaultCriticPrompt()).toMatch(/Begin directly with PLAN REVIEW/);
	});

	test('default critic agent keeps the base critic identity', () => {
		const agent = createCriticAgent('test-model');
		expect(agent.name).toBe('critic');
	});
});
