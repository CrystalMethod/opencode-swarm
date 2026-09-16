/**
 * Edge-case integration tests for the unified injection budget (FR-002).
 *
 * Covers single-component overruns and proportional allocation at the ceiling.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
	KnowledgeConfig,
	MessageWithParts,
	PluginConfig,
} from '../../src/config';
import { createKnowledgeInjectorHook } from '../../src/hooks/knowledge-injector.js';
import {
	allocateInjectionBudget,
	clearTurnLedger,
	type InjectionBudgetConfig,
} from '../../src/services/injection-budget.js';
import { resetSwarmState } from '../../src/state.js';
import { canonicalMkdtemp } from '../helpers/tmpdir.js';

const PLAN_JSON = JSON.stringify({
	schema_version: '1.0.0',
	swarm: 'unified-budget-test',
	title: 'Unified Budget Integration Test',
	current_phase: 1,
	phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
});

function makeKnowledgeEntry(id: string, lesson: string): string {
	return JSON.stringify({
		id,
		tier: 'swarm',
		lesson,
		category: 'process',
		tags: ['test'],
		scope: 'global',
		confidence: 0.8,
		status: 'established',
		confirmed_by: [
			{
				phase_number: 1,
				confirmed_at: '2024-01-01T00:00:00.000Z',
				project_name: 'test',
			},
		],
		retrieval_outcomes: {
			applied_count: 2,
			succeeded_after_count: 2,
			failed_after_count: 0,
		},
		schema_version: 1,
		created_at: '2024-01-01T00:00:00.000Z',
		updated_at: '2024-01-01T00:00:00.000Z',
		project_name: 'test',
	});
}

const KNOWLEDGE_JSONL = [
	makeKnowledgeEntry('aaaa-0001', 'Always run tests before merging'),
	makeKnowledgeEntry('bbbb-0002', 'Use structured logging for debugging'),
	makeKnowledgeEntry('cccc-0003', 'Pin dependency versions in CI'),
].join('\n');

const DEFAULT_KNOWLEDGE_CONFIG: KnowledgeConfig = {
	enabled: true,
	swarm_max_entries: 100,
	hive_max_entries: 200,
	auto_promote_days: 90,
	max_inject_count: 5,
	inject_char_budget: 2000,
	max_lesson_display_chars: 120,
	dedup_threshold: 0.6,
	scope_filter: ['global'],
	hive_enabled: false,
	rejected_max_entries: 20,
	validation_enabled: true,
	evergreen_confidence: 0.9,
	evergreen_utility: 0.8,
	low_utility_threshold: 0.3,
	min_retrievals_for_utility: 3,
	schema_version: 1,
	same_project_weight: 1.0,
	cross_project_weight: 0.5,
	min_encounter_score: 0.1,
	initial_encounter_score: 1.0,
	encounter_increment: 0.1,
	max_encounter_score: 10.0,
};

const DEFAULT_PLUGIN_CONFIG: PluginConfig = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
};

function makeMessages(totalChars: number): MessageWithParts[] {
	const sysText = 'System prompt for architect agent';
	const userPad = Math.max(1, totalChars - sysText.length);
	return [
		{
			info: { role: 'assistant', sessionID: 'test-session' },
			parts: [{ type: 'text', text: sysText }],
		},
		{
			info: { role: 'user', agent: 'architect', sessionID: 'test-session' },
			parts: [{ type: 'text', text: 'x'.repeat(userPad) }],
		},
	];
}

function findInjectedMessage(
	messages: MessageWithParts[],
): MessageWithParts | undefined {
	return messages.find((m) =>
		m.parts?.some((p) => p.text?.includes('\u{1F4DA} Lessons:')),
	);
}

function totalTextLength(msg: MessageWithParts): number {
	return msg.parts.reduce((sum, p) => sum + (p.text?.length ?? 0), 0);
}

describe('Unified injection budget edge cases (FR-002)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('unified-budget-test-');
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(path.join(swarmDir, 'plan.json'), PLAN_JSON);
		fs.writeFileSync(path.join(swarmDir, 'plan.md'), '# Plan\n');
		fs.writeFileSync(path.join(swarmDir, 'context.md'), '# Context\n');
		fs.writeFileSync(path.join(swarmDir, 'knowledge.jsonl'), KNOWLEDGE_JSONL);
		resetSwarmState();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		clearTurnLedger('test-session');
	});

	// SC-005 (kiDemand >= ceiling): knowledge-injector alone exceeds budget

	it('SC-005: system-enhancer gets 0 when knowledge-injector demand alone exceeds the unified ceiling', () => {
		// With seDemand=0 and kiChars=2000 (kiDemand≈660), ceiling=500:
		// kiDemand(660) >= ceiling(500) → SE gets 0, KI gets 500.
		// This exercises the kiDemand >= ceiling branch (lines 108-114).
		const config: InjectionBudgetConfig = { totalBudgetTokens: 500 };
		const result = allocateInjectionBudget(0, 2000, config);
		expect(result.systemEnhancerTokens).toBe(0);
		expect(result.knowledgeInjectorTokens).toBe(500);
		expect(result.totalTokens).toBe(500);
	});

	it('SC-005: hook flow — kiChars exceeds ceiling, SE gets 0, KI capped at ceiling', async () => {
		// Integration variant: verify hook respects kiDemand >= ceiling result.
		// Set a low unified ceiling (500) so that kiChars=2000 (kiDemand=660) > 500.
		// SE demand = 0 (not called), kiChars capped at maxInjectChars=2000 → kiDemand=660 > 500.
		const unifiedBudget = 500;
		const pluginConfig: PluginConfig = {
			...DEFAULT_PLUGIN_CONFIG,
			context_budget: {
				max_injection_tokens: 4000,
				unified_injection_tokens: unifiedBudget,
			},
		};
		const knowledgeConfig = { ...DEFAULT_KNOWLEDGE_CONFIG };

		// SE not called → seDemand = 0 from getSystemEnhancerDemand
		// KI hook: effectiveBudget = maxInjectChars = 2000
		// kiDemand = ceil(2000 * 0.33) = 660 > 500 → SE gets 0
		const kiHook = createKnowledgeInjectorHook(
			tempDir,
			knowledgeConfig,
			{},
			unifiedBudget,
		);
		const kiMessages = makeMessages(20_000);
		const kiOutput = { messages: kiMessages };
		await kiHook({} as Record<string, never>, kiOutput);
		const kiInjected = findInjectedMessage(kiOutput.messages);
		// With SE getting 0, KI's allocation = 500 tokens ≈ 1515 chars.
		// This should still be >= MIN_INJECT_CHARS (300), so injection proceeds.
		expect(kiInjected).toBeDefined();
		const kiChars = totalTextLength(kiInjected!);
		// kiChars should be capped around 1515 (500 tokens / 0.33)
		expect(kiChars).toBeLessThanOrEqual(1600);
	});

	// -----------------------------------------------------------------------
	// SC-006: proportional split when neither component alone exceeds ceiling
	// -----------------------------------------------------------------------

	it('SC-006: proportional split — both demands under ceiling but combined exceeds it', () => {
		// seDemand=3000, kiChars=4000 (kiDemand≈1320), combined=4320, ceiling=4000.
		// Neither alone (3000 < 4000, 1320 < 4000) but combined > ceiling.
		// Proportional: seShare = floor(3000/4320 * 4000) = 2777, kiShare = 4000-2777 = 1223.
		// This exercises the proportional split branch (lines 116-127).
		const config: InjectionBudgetConfig = { totalBudgetTokens: 4000 };
		const result = allocateInjectionBudget(3000, 4000, config);
		expect(result.totalTokens).toBe(4000);
		expect(result.systemEnhancerTokens).toBe(2777);
		expect(result.knowledgeInjectorTokens).toBe(1223);
		expect(result.systemEnhancerTokens).toBeGreaterThan(0);
		expect(result.knowledgeInjectorTokens).toBeGreaterThan(0);
	});

	it('SC-006: proportional split with seDemand just under ceiling (edge case)', () => {
		// seDemand=3999, kiChars=4000 (kiDemand≈1320), combined=5319, ceiling=4000.
		// seDemand(3999) < 4000, kiDemand(1320) < 4000, combined(5319) > 4000.
		// seShare = floor(3999/5319 * 4000) = floor(3007.34) = 3007, kiShare = 4000-3007 = 993.
		const config: InjectionBudgetConfig = { totalBudgetTokens: 4000 };
		const result = allocateInjectionBudget(3999, 4000, config);
		expect(result.totalTokens).toBe(4000);
		expect(result.systemEnhancerTokens).toBe(3007);
		expect(result.knowledgeInjectorTokens).toBe(993);
		// Both components get non-zero
		expect(result.systemEnhancerTokens + result.knowledgeInjectorTokens).toBe(
			4000,
		);
	});
});
