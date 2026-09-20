/**
 * Shared skill contract-digest primitives (issue #2601).
 *
 * Single source of truth for the `swarm-contract-digest` stamp scheme
 * introduced by #2859 F6: both the dev-time drift-check detector
 * (scripts/drift-check.ts) and the runtime activation/wake verification
 * (src/services/pr-workflow-skill-contract.ts) import from here so the two
 * surfaces can never disagree on what the stamp means. Previously these
 * helpers lived only in the dev-time script; src/ must not import from
 * scripts/, so the algorithms moved here and the script re-exports them.
 */
import { createHash } from 'node:crypto';

export const SKILL_CONTRACT_DIGEST_KEY = 'swarm-contract-digest';

/**
 * Split a SKILL.md into its frontmatter block (fences included) and body.
 * A file without a well-formed opening/closing fence pair has no frontmatter.
 */
export function splitSkillFrontmatter(content: string): {
	frontmatter: string;
	body: string;
} {
	if (!content.startsWith('---\n')) return { frontmatter: '', body: content };
	const end = content.indexOf('\n---\n', 4);
	if (end === -1) return { frontmatter: '', body: content };
	return {
		frontmatter: content.slice(0, end + 5),
		body: content.slice(end + 5),
	};
}

/**
 * 12-hex content digest of a skill BODY (frontmatter excluded, line endings
 * normalized) — stable across platforms regardless of checkout EOL settings.
 */
export function skillContractDigest(body: string): string {
	const normalized = body.replace(/\r\n/g, '\n');
	return createHash('sha256')
		.update(normalized, 'utf8')
		.digest('hex')
		.slice(0, 12);
}

/**
 * Read the stamped contract digest from a frontmatter block, if present.
 * String.match rather than RegExp.exec: the SAST callee-binding classifier
 * (issue #2300) flags an unresolved .exec member call as exec-like.
 */
export function readSkillContractStamp(
	frontmatter: string,
): string | undefined {
	const match = frontmatter
		.replace(/\r\n/g, '\n')
		.match(new RegExp(`^${SKILL_CONTRACT_DIGEST_KEY}: ([0-9a-f]{12})$`, 'm'));
	return match?.[1];
}
