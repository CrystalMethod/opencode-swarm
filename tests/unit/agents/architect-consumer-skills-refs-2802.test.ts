import { describe, expect, test } from 'bun:test';
import { createArchitectAgent } from '../../../src/agents/architect';

/**
 * Guardrail for issue #2802 — consumer-project skill references.
 *
 * The architect system prompt must not carry copyable literal delegation
 * example lines naming opencode-swarm source-repo skill paths
 * (`.claude/skills/engineering-conventions/SKILL.md`,
 * `.claude/skills/writing-tests/SKILL.md`). In consumer projects those files
 * do not exist, the delegation gate fail-closes on the reference
 * (`validateExplicitSkillReferencesBefore` → `skill file does not exist`), and
 * the coder task never runs until the architect re-delegates.
 *
 * The fix replaced the literal examples with a `<project-skill>` placeholder
 * plus an existence-check NOTE, and reworded the "Mandatory for coding tasks"
 * guidance so `writing-tests` / `engineering-conventions` are marked as
 * examples from the opencode-swarm source repo that may only be referenced
 * when they exist in the current project (else `SKILLS: none`).
 */

const prompt = createArchitectAgent('test-model').config.prompt ?? '';

function skillsPropagationSection(text: string): string {
	const start = text.indexOf('## SKILLS PROPAGATION');
	if (start < 0) return '';
	const next = text.indexOf('\n## ', start + 1);
	return next < 0 ? text.slice(start) : text.slice(start, next);
}

function delegationFormatSection(text: string): string {
	const start = text.indexOf('## DELEGATION FORMAT');
	if (start < 0) return '';
	const next = text.indexOf('\n## ', start + 1);
	return next < 0 ? text.slice(start) : text.slice(start, next);
}

/** Same predicate as acceptance check C2 (issue-tracer trace 2802). */
const LITERAL_REPO_SKILLS_LINE =
	/(?:SKILLS_USED_BY_CODER|SKILLS)\s*:[^\n]*file:\s*\.claude\/skills\/(?:engineering-conventions|writing-tests)\/SKILL\.md/i;

describe('architect prompt — consumer-project SKILLS references (#2802)', () => {
	test('no delegation example line names a repo-specific skill path verbatim', () => {
		const offenders = prompt
			.split('\n')
			.filter((line) => LITERAL_REPO_SKILLS_LINE.test(line.trim()));
		expect(offenders).toEqual([]);
	});

	test('coding-task skills are marked as source-repo examples, not universal defaults', () => {
		const section = skillsPropagationSection(prompt);
		expect(section).not.toBe('');
		expect(section).toMatch(/opencode-swarm|source\s+repo(?:sitory)?/i);
		expect(section).toMatch(/current\s+project/i);
		expect(section).toMatch(/otherwise[^\n]{0,120}SKILLS:\s*`?none/i);
		// Pinned to acceptance check C1's regex verbatim — the two cannot drift.
		expect(section).not.toMatch(
			/always\s+provide[^\n]{0,120}(?:writing-tests|engineering-conventions)/i,
		);
	});

	test('skill-propagation machinery is retained', () => {
		const section = skillsPropagationSection(prompt);
		expect(section).toContain('SKILL_LOAD_FAILED');
		expect(section).toContain('do NOT retry with the same reference');
		expect(section).toContain('SKILLS_USED_BY_CODER');
		expect(section).toMatch(/prefer[^\n]{0,120}file:/i);
	});

	test('examples still teach skill attachment via the placeholder form', () => {
		const delegation = delegationFormatSection(prompt);
		expect(delegation).not.toBe('');
		expect(delegation).toContain(
			'SKILLS: file:.claude/skills/<project-skill>/SKILL.md',
		);
	});

	test('reviewer forwarding example retains a SKILLS_USED_BY_CODER field line', () => {
		const delegation = delegationFormatSection(prompt);
		expect(delegation).not.toBe('');
		expect(delegation).toMatch(/^\s*SKILLS_USED_BY_CODER:\s*\S+/m);
	});

	test('placeholder carries an existence-check note', () => {
		const delegation = delegationFormatSection(prompt);
		expect(delegation).not.toBe('');
		expect(delegation).toMatch(
			/<project-skill>[^\n]{0,200}placeholder|placeholder[^\n]{0,200}<project-skill>/i,
		);
		expect(delegation).toMatch(
			/which skills actually exist in the current project/i,
		);
	});
});
