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
	SKILL_CONTRACT_DIGEST_KEY,
	STAMPED_PR_WORKFLOW_SKILLS,
	skillContractDigest,
	splitSkillFrontmatter,
} from './drift-check';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRITE = process.argv.includes('--write');

let drift = 0;
for (const slug of STAMPED_PR_WORKFLOW_SKILLS) {
	const file = path.join(REPO_ROOT, '.opencode', 'skills', slug, 'SKILL.md');
	const content = readFileSync(file, 'utf8');
	const normalized = content.replace(/\r\n/g, '\n');
	const { frontmatter, body } = splitSkillFrontmatter(normalized);
	const digest = skillContractDigest(body);
	const stampLine = `${SKILL_CONTRACT_DIGEST_KEY}: ${digest}`;
	const existing = new RegExp(
		`^${SKILL_CONTRACT_DIGEST_KEY}: ([0-9a-f]{12})$`,
		'm',
	).exec(frontmatter)?.[1];
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
	const next = existing
		? normalized.replace(
				new RegExp(`^${SKILL_CONTRACT_DIGEST_KEY}: [0-9a-f]{12}$`, 'm'),
				stampLine,
			)
		: normalized.replace(/^---\n/, `---\n${stampLine}\n`);
	writeFileSync(file, next, 'utf8');
	console.log(`stamped ${slug} ${digest}${existing ? ` (was ${existing})` : ''}`);
}
if (drift > 0) process.exit(1);
