/**
 * Issue #2859 (F6): write `swarm-contract-digest:` content stamps into the
 * frontmatter of the mirrored PR-workflow skills (see STAMPED_PR_WORKFLOW_SKILLS
 * in scripts/drift-check.ts). The stamp is a 12-hex sha256 of the skill BODY
 * (frontmatter excluded, line endings normalized) so it survives checkout EOL
 * differences. Idempotent: re-running replaces any existing stamp.
 *
 * Usage:
 *   bun run scripts/stamp-skill-contracts.ts --write   # write stamps
 *   bun run scripts/stamp-skill-contracts.ts            # check only (exit 1 on drift)
 *
 * The drift-check detector `user-global-skill-staleness` treats a repo-side
 * stamp/body mismatch as a warning — run this script after editing any of the
 * stamped skills.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	readSkillContractStamp,
	SKILL_CONTRACT_DIGEST_KEY,
	skillContractDigest,
	splitSkillFrontmatter,
} from '../src/config/skill-contract-digest.js';
import { STAMPED_PR_WORKFLOW_SKILLS } from './drift-check';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRITE = process.argv.includes('--write');

let drift = 0;
for (const slug of STAMPED_PR_WORKFLOW_SKILLS) {
	const file = path.join(REPO_ROOT, '.opencode', 'skills', slug, 'SKILL.md');
	const content = readFileSync(file, 'utf8');
	const normalized = content.replace(/\r\n/g, '\n');
	const { frontmatter, body } = splitSkillFrontmatter(normalized);
	const digest = skillContractDigest(body);
	const existing = readSkillContractStamp(frontmatter);
	if (existing === digest) {
		console.log(`ok      ${slug} ${digest}`);
		continue;
	}
	if (!WRITE) {
		console.log(
			`drift   ${slug}: stamp ${existing ?? '<none>'} != body ${digest} (run with --write)`,
		);
		drift += 1;
		continue;
	}
	const { frontmatter: fmSlice, body: bodySlice } =
		splitSkillFrontmatter(normalized);
	const next = existing
		? // Re-stamp in place: bound the replace to the frontmatter slice so a
		  // body line shaped like the stamp can never be rewritten (PRR-006).
			fmSlice.replace(
				new RegExp(
					`^(\\s*)${SKILL_CONTRACT_DIGEST_KEY}: ?"?[0-9a-f]{12}"?[ \\t]*$`,
					'm',
				),
				`$1${SKILL_CONTRACT_DIGEST_KEY}: "${digest}"`,
			) + bodySlice
		: insertStamp(normalized, digest);
	// N-3 (PR #2863 review): a skill without a frontmatter fence made the
	// helper return the input unchanged and the loop still wrote it and
	// reported `stamped` — a false success. Fail closed instead so the next
	// check run keeps flagging the slug instead of silently "fixing" it.
	if (!existing && next === normalized) {
		console.error(
			`skipped ${slug}: no frontmatter fence; stamp not inserted (fix the SKILL.md frontmatter)`,
		);
		drift += 1;
		continue;
	}
	writeFileSync(file, next, 'utf8');
	console.log(`stamped ${slug} ${digest}${existing ? ` (was ${existing})` : ''}`);
}
/**
 * Insert the stamp as a quoted-string child of the `metadata:` map when one
 * exists (spec shape, issue #2907), otherwise as the LAST top-level
 * frontmatter key immediately before the closing fence: the legacy
 * positional contract only requires the fence to open with name:, and the
 * pre-#2907 runtime closure asserted `audience:` directly after `name:`.
 */
function insertStamp(content: string, digest: string): string {
	// Search the FRONTMATTER slice only: a column-0 `metadata:` in the skill
	// body must never capture the stamp (PRR-006) — an unbounded whole-file
	// match produced a self-invalidating stamp inside body text.
	const { frontmatter: fmSlice, body: bodySlice } =
		splitSkillFrontmatter(content);
	const metadataLabel = /^metadata:[ \t]*$/m.exec(fmSlice);
	if (metadataLabel?.index !== undefined) {
		// +1 skips the line terminator (content is LF-normalized above).
		const afterLabel = metadataLabel.index + metadataLabel[0].length + 1;
		const child = `  ${SKILL_CONTRACT_DIGEST_KEY}: "${digest}"\n`;
		return fmSlice.slice(0, afterLabel) + child + fmSlice.slice(afterLabel) + bodySlice;
	}
	const close = content.indexOf('\n---\n');
	if (close === -1) return content;
	return content.slice(0, close) + `\n${SKILL_CONTRACT_DIGEST_KEY}: "${digest}"` + content.slice(close);
}

if (drift > 0) process.exit(1);
