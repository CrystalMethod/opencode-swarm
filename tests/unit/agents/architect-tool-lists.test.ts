/**
 * Tests for architect tool list generation functions.
 *
 * Verifies that YOUR TOOLS and Available Tools in the architect prompt are
 * generated from AGENT_TOOL_MAP.architect as the single source of truth,
 * replacing the previously hand-maintained lists.
 *
 * Covers:
 * 1. YOUR TOOLS contains all AGENT_TOOL_MAP.architect tools
 * 2. YOUR TOOLS starts with "Task (delegation),"
 * 3. Available Tools contains all AGENT_TOOL_MAP.architect tools
 * 4. Available Tools has descriptions (e.g. "build_check (build verification)")
 * 5. Both lists are sorted alphabetically (after "Task (delegation)" prefix for YOUR TOOLS)
 * 6. Tool count matches AGENT_TOOL_MAP.architect.length
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import {
	ARCHITECT_TOOL_DESCRIPTION_PROMPT_CAP_CHARS,
	capToolDescriptionForPrompt,
	createArchitectAgent,
} from '../../../src/agents/architect.js';
import {
	AGENT_TOOL_MAP,
	COUNCIL_AGENT_TOOL_MAP,
	GENERAL_COUNCIL_AGENT_TOOL_MAP,
	TOOL_DESCRIPTIONS,
} from '../../../src/config/constants.js';

const BASE_ARCHITECT_TOOL_COUNT = AGENT_TOOL_MAP['architect'].length;
const COUNCIL_ARCHITECT_TOOL_COUNT = (COUNCIL_AGENT_TOOL_MAP['architect'] ?? [])
	.length;
const GENERAL_COUNCIL_ARCHITECT_TOOL_COUNT = (
	GENERAL_COUNCIL_AGENT_TOOL_MAP['architect'] ?? []
).length;
const ARCHITECT_TOOL_COUNT =
	BASE_ARCHITECT_TOOL_COUNT +
	COUNCIL_ARCHITECT_TOOL_COUNT +
	GENERAL_COUNCIL_ARCHITECT_TOOL_COUNT;

let resolvedPrompt: string;

// ---------------------------------------------------------------------------
// Helper: extract Available Tools tool names from resolved prompt
// ---------------------------------------------------------------------------
function extractAvailableToolsNames(prompt: string): string[] {
	// Find line like: "Available Tools: tool1 (desc), tool2 (desc), ..."
	const match = prompt.match(/^Available Tools:\s*(.+?)$/m);
	if (!match) return [];

	const line = match[1];
	const segments: string[] = [];
	let current = '';
	let depth = 0;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '(') depth++;
		if (ch === ')') depth--;
		if (ch === ',' && depth === 0) {
			segments.push(current.trim());
			current = '';
		} else {
			current += ch;
		}
	}
	if (current.trim()) segments.push(current.trim());

	return segments
		.map((seg) => seg.match(/^(\w+)/)?.[1])
		.filter(Boolean) as string[];
}

// Render with council.enabled=true so the full AGENT_TOOL_MAP.architect
// surface (including `submit_council_verdicts` and `declare_council_criteria`)
// appears in YOUR TOOLS and Available Tools. Without council enabled,
// those tools are filtered out of the prompt — see
// architect-tool-visibility-council.test.ts for the council-off behavior.
beforeAll(() => {
	// Both councils enabled so the full AGENT_TOOL_MAP.architect surface
	// (submit_council_verdicts, declare_council_criteria, AND convene_general_council)
	// renders into YOUR TOOLS and Available Tools.
	const agent = createArchitectAgent(
		'test-model',
		undefined,
		undefined,
		undefined,
		{ enabled: true, general: { enabled: true } },
	);
	resolvedPrompt = agent.config.prompt ?? '';
});

describe('YOUR TOOLS generation from AGENT_TOOL_MAP', () => {
	it('contains all AGENT_TOOL_MAP.architect tools', () => {
		for (const tool of AGENT_TOOL_MAP['architect']) {
			expect(resolvedPrompt).toContain(tool);
		}
	});

	it('starts with "Task (delegation)," prefix', () => {
		// Extract YOUR TOOLS line - multiline match to capture just this line
		const yourToolsMatch = resolvedPrompt.match(/^YOUR TOOLS: (.+?)$/m);
		expect(yourToolsMatch).not.toBeNull();
		const yourToolsSection = yourToolsMatch![1];
		expect(yourToolsSection.trim().startsWith('Task (delegation),')).toBe(true);
	});

	it('tool count matches AGENT_TOOL_MAP.architect.length', () => {
		// Extract YOUR TOOLS line
		const yourToolsMatch = resolvedPrompt.match(/^YOUR TOOLS: (.+?)$/m);
		expect(yourToolsMatch).not.toBeNull();
		const yourToolsSection = yourToolsMatch![1];

		// Remove prefix, split by comma+space, trim trailing period
		const afterPrefix = yourToolsSection
			.replace('Task (delegation),', '')
			.trim();
		const toolsStr = afterPrefix.replace(/\.\s*$/, ''); // remove trailing period
		const tools = toolsStr
			.split(',')
			.map((t) => t.trim())
			.filter(Boolean);

		expect(tools.length).toBe(ARCHITECT_TOOL_COUNT);
	});

	it('tools after prefix are sorted alphabetically', () => {
		const yourToolsMatch = resolvedPrompt.match(/^YOUR TOOLS: (.+?)$/m);
		expect(yourToolsMatch).not.toBeNull();
		const yourToolsSection = yourToolsMatch![1];

		const afterPrefix = yourToolsSection
			.replace('Task (delegation),', '')
			.trim();
		const toolsStr = afterPrefix.replace(/\.\s*$/, '');
		const tools = toolsStr
			.split(',')
			.map((t) => t.trim())
			.filter(Boolean);

		const sorted = [...tools].sort();
		expect(tools).toEqual(sorted);
	});
});

describe('Available Tools generation from AGENT_TOOL_MAP', () => {
	it('contains all AGENT_TOOL_MAP.architect tools', () => {
		for (const tool of AGENT_TOOL_MAP['architect']) {
			expect(resolvedPrompt).toContain(tool);
		}
	});

	it('has descriptions for tools that have TOOL_DESCRIPTIONS entries', () => {
		for (const tool of [
			'build_check',
			'checkpoint',
			'collect_lane_results',
			'dispatch_lanes',
			'dispatch_lanes_async',
		]) {
			const description =
				TOOL_DESCRIPTIONS[tool as keyof typeof TOOL_DESCRIPTIONS];
			expect(description).toBeTruthy();
			// Issue #2671: descriptions render in the prompt bounded by
			// capToolDescriptionForPrompt (cap + trailing unclosed parenthetical
			// stripped so entries keep balanced parentheses) followed by a
			// visible ellipsis when truncation occurred. Asserting the capped
			// PREFIX with no trailing character holds for both the full render
			// (cap is the identity) and the bounded render.
			const capped = capToolDescriptionForPrompt(description);
			expect(resolvedPrompt).toContain(`${tool} (${capped}`);
			if (capped !== description) {
				expect(resolvedPrompt).toContain(`${tool} (${capped}…)`);
			}
		}
	});

	it('tool count matches AGENT_TOOL_MAP.architect.length', () => {
		const tools = extractAvailableToolsNames(resolvedPrompt);
		expect(tools.length).toBe(ARCHITECT_TOOL_COUNT);
	});

	it('caps every over-cap TOOL_DESCRIPTIONS entry to balanced output (property pin, issue #2671 review)', () => {
		// Independent of the helper-as-oracle coupling: this pins a PROPERTY
		// (balanced parens, under-cap prefix, visible ellipsis) over every real
		// description reachable in the architect render, not exact text.
		let overCap = 0;
		for (const [tool, description] of Object.entries(TOOL_DESCRIPTIONS)) {
			if (description.length <= ARCHITECT_TOOL_DESCRIPTION_PROMPT_CAP_CHARS) {
				continue;
			}
			overCap++;
			const capped = capToolDescriptionForPrompt(description);
			expect(
				capped.length,
				`${tool}: capped form must not exceed the cap`,
			).toBeLessThanOrEqual(ARCHITECT_TOOL_DESCRIPTION_PROMPT_CAP_CHARS);
			// Review ROW-1: balancing now APPENDS closers for unmatched opens
			// instead of discarding the parenthetical, so the output is the
			// description's prefix plus a short synthetic closer run — strip the
			// closers before checking the prefix property.
			const stripped = capped.replace(/\)+$/, '');
			expect(
				description.startsWith(stripped),
				`${tool}: capped form minus its appended closers must be a prefix of the description`,
			).toBe(true);
			let depth = 0;
			let minDepth = 0;
			for (const ch of capped) {
				if (ch === '(') depth++;
				if (ch === ')') depth--;
				minDepth = Math.min(minDepth, depth);
			}
			expect(
				depth,
				`${tool}: capped form must be paren-balanced (closers appended)`,
			).toBe(0);
			expect(
				minDepth,
				`${tool}: capped form must not contain text outside a closed leading parenthetical group`,
			).toBeGreaterThanOrEqual(0);
		}
		expect(overCap).toBeGreaterThan(0);
	});

	it('retains near-cap content for descriptions whose cap window falls mid-parenthetical (magnitude pin, review ROW-1/ROW-2)', () => {
		// The previous discard-from-last-unmatched-open strategy collapsed
		// get_qa_gate_profile 310→81 and context_status 657→146 chars. The
		// append-closers strategy must retain near-cap content for these real
		// descriptions — pin the magnitude so a future regression to a
		// discarding strategy fails here.
		const magnitudePinnedTools = [
			'get_qa_gate_profile',
			'context_status',
		] as const;
		for (const tool of magnitudePinnedTools) {
			const description = TOOL_DESCRIPTIONS[tool];
			expect(description?.length ?? 0).toBeGreaterThan(
				ARCHITECT_TOOL_DESCRIPTION_PROMPT_CAP_CHARS,
			);
			const capped = capToolDescriptionForPrompt(description!);
			expect(
				capped.length,
				`${tool}: cap must retain near-cap content (magnitude pin)`,
			).toBeGreaterThanOrEqual(
				ARCHITECT_TOOL_DESCRIPTION_PROMPT_CAP_CHARS - 10,
			);
		}
	});

	it('capToolDescriptionForPrompt strips multi-iteration unclosed groups and passes through balanced input', () => {
		// Dedicated unit coverage for the strip loop (review PRR-111): nested
		// unclosed groups require multiple loop iterations.
		const nested = `${'a'.repeat(200)} (outer (inner (deepest ${'b'.repeat(50)}`;
		const capped = capToolDescriptionForPrompt(nested);
		expect(capped.length).toBeLessThanOrEqual(
			ARCHITECT_TOOL_DESCRIPTION_PROMPT_CAP_CHARS,
		);
		let depth = 0;
		for (const ch of capped) {
			if (ch === '(') depth++;
			if (ch === ')') depth--;
		}
		expect(depth).toBeLessThanOrEqual(0);
		expect(capped.endsWith('(')).toBe(false);

		// Balanced within-cap input is byte-identical.
		const balanced = 'tool use (with parens (nested) too) for caps';
		expect(capToolDescriptionForPrompt(balanced)).toBe(balanced);
	});

	it('tools are sorted alphabetically', () => {
		const tools = extractAvailableToolsNames(resolvedPrompt);
		const sorted = [...tools].sort();
		expect(tools).toEqual(sorted);
	});
});

describe('Single source of truth verification', () => {
	it('YOUR TOOLS and Available Tools count both match AGENT_TOOL_MAP.architect.length', () => {
		// Extract YOUR TOOLS line
		const yourToolsMatch = resolvedPrompt.match(/^YOUR TOOLS: (.+?)$/m);
		expect(yourToolsMatch).not.toBeNull();
		const yourToolsSection = yourToolsMatch![1];
		const afterPrefix = yourToolsSection
			.replace('Task (delegation),', '')
			.trim();
		const yourToolsStr = afterPrefix.replace(/\.\s*$/, '');
		const yourTools = yourToolsStr
			.split(',')
			.map((t) => t.trim())
			.filter(Boolean);

		// Extract Available Tools line
		const availableTools = extractAvailableToolsNames(resolvedPrompt);

		expect(yourTools.length).toBe(ARCHITECT_TOOL_COUNT);
		expect(availableTools.length).toBe(ARCHITECT_TOOL_COUNT);
	});

	it('a new tool added to AGENT_TOOL_MAP.architect would appear in the generated prompt', () => {
		// This is verified by the count test: if AGENT_TOOL_MAP.architect.length
		// changes, the count test will fail until the prompt is regenerated.
		// We verify the mechanism is correct by confirming all current tools are present.
		const allPresent = AGENT_TOOL_MAP['architect'].every((tool) =>
			resolvedPrompt.includes(tool),
		);
		expect(allPresent).toBe(true);
	});
});
