/**
 * Issue #2601 regression: the runtime skill-contract verifier.
 *
 * ensurePrWorkflowSkillContractsFresh detects a stale installed bundled copy,
 * heals it through the (injected) bundled sync, records an advisory naming
 * BOTH the stale path and the canonical source, checks user-global copies
 * read-only, and fail-opens when there is no canonical to verify against.
 * All fixtures use the module's `_internals` seams (AGENTS.md invariant 7).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { STAMPED_PR_WORKFLOW_SKILLS } from '../../../scripts/drift-check';
import {
	readSkillContractStamp,
	skillContractDigest,
	splitSkillFrontmatter,
} from '../../../src/config/skill-contract-digest.js';
import {
	_internals,
	ensurePrWorkflowSkillContractsFresh,
	nearestPackageRootFrom,
} from '../../../src/services/pr-workflow-skill-contract.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const originalInternals = { ..._internals };
const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
	const root = canonicalMkdtemp(prefix);
	tempRoots.push(root);
	return root;
}

function writeSkill(file: string, body: string, stamp?: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const frontmatter = [
		'---',
		'name: swarm-pr-review',
		'audience: swarm-plugin',
	];
	if (stamp) frontmatter.splice(1, 0, `swarm-contract-digest: ${stamp}`);
	fs.writeFileSync(file, `${frontmatter.join('\n')}\n---\n${body}`, 'utf8');
}

/** Fixture package root whose canonical is authoritative for the test. */
function makePackageFixture(): { packageRoot: string; canonical: string } {
	const packageRoot = makeTempRoot('sw2601-pkg-');
	const canonical = path.join(
		packageRoot,
		'.opencode',
		'skills',
		'swarm-pr-review',
		'SKILL.md',
	);
	const body = '# canonical body\n\ncurrent guidance\n';
	writeSkill(canonical, body, skillContractDigest(body));
	return { packageRoot, canonical };
}

/** Injected sync that copies the canonical into the installed slot. */
function installCopyingSync(packageRoot: string, calls: () => void) {
	_internals.syncBundled = async (projectDirectory) => {
		calls();
		fs.mkdirSync(
			path.join(
				projectDirectory,
				'.swarm',
				'bundled-skills',
				'swarm-pr-review',
			),
			{ recursive: true },
		);
		fs.copyFileSync(
			path.join(
				packageRoot,
				'.opencode',
				'skills',
				'swarm-pr-review',
				'SKILL.md',
			),
			path.join(
				projectDirectory,
				'.swarm',
				'bundled-skills',
				'swarm-pr-review',
				'SKILL.md',
			),
		);
	};
}

beforeEach(() => {
	// Tests never touch the real host home: point the seam at a temp home by
	// default; user-global legs overwrite it per-case.
	_internals.resolveUserGlobalHome = () => makeTempRoot('sw2601-home-');
});

afterEach(() => {
	Object.assign(_internals, originalInternals);
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('ensurePrWorkflowSkillContractsFresh (issue #2601)', () => {
	test('heals a stale bundled copy and records an advisory naming both paths', async () => {
		const { packageRoot, canonical } = makePackageFixture();
		const project = makeTempRoot('sw2601-proj-');
		const installed = path.join(
			project,
			'.swarm',
			'bundled-skills',
			'swarm-pr-review',
			'SKILL.md',
		);
		writeSkill(installed, '# stale\n');
		let syncCalls = 0;
		installCopyingSync(packageRoot, () => {
			syncCalls += 1;
		});
		_internals.resolvePackageRoot = () => packageRoot;

		const advisories = await ensurePrWorkflowSkillContractsFresh(
			project,
			'PR_REVIEW',
		);

		expect(syncCalls).toBe(1);
		const healed = skillContractDigest(
			splitSkillFrontmatter(fs.readFileSync(installed, 'utf8')).body,
		);
		const canonicalDigest = skillContractDigest(
			splitSkillFrontmatter(fs.readFileSync(canonical, 'utf8')).body,
		);
		expect(healed).toBe(canonicalDigest);
		expect(advisories.length).toBe(1);
		expect(advisories[0]).toContain('swarm-pr-review');
		expect(
			advisories[0]
				.replace(/\\/g, '/')
				.includes('.swarm/bundled-skills/swarm-pr-review/SKILL.md'),
		).toBe(true);
		expect(
			advisories[0]
				.replace(/\\/g, '/')
				.includes('.opencode/skills/swarm-pr-review/SKILL.md'),
		).toBe(true);
		expect(advisories[0]).toContain('refreshed from the canonical source');
	});

	test('clean host: fresh bundled copy and no user-global copies yield no advisories', async () => {
		const { packageRoot, canonical } = makePackageFixture();
		const project = makeTempRoot('sw2601-clean-');
		fs.mkdirSync(path.dirname(canonical), { recursive: true });
		fs.mkdirSync(
			path.join(project, '.swarm', 'bundled-skills', 'swarm-pr-review'),
			{ recursive: true },
		);
		fs.copyFileSync(
			canonical,
			path.join(
				project,
				'.swarm',
				'bundled-skills',
				'swarm-pr-review',
				'SKILL.md',
			),
		);
		_internals.resolvePackageRoot = () => packageRoot;
		installCopyingSync(packageRoot, () => {});

		const advisories = await ensurePrWorkflowSkillContractsFresh(
			project,
			'PR_REVIEW',
		);
		expect(advisories).toEqual([]);
	});

	test('user-global arm is advisory-only and never writes the home tree', async () => {
		const { packageRoot } = makePackageFixture();
		const project = makeTempRoot('sw2601-user-');
		const home = makeTempRoot('sw2601-stalehome-');
		const userCopy = path.join(
			home,
			'.opencode',
			'skills',
			'swarm-pr-review',
			'SKILL.md',
		);
		writeSkill(userCopy, '# ten-week-old shadow copy\n');
		const before = fs.readFileSync(userCopy, 'utf8');
		_internals.resolvePackageRoot = () => packageRoot;
		_internals.resolveUserGlobalHome = () => home;
		installCopyingSync(packageRoot, () => {});

		const advisories = await ensurePrWorkflowSkillContractsFresh(
			project,
			'PR_REVIEW',
		);

		expect(fs.readFileSync(userCopy, 'utf8')).toBe(before);
		const userAdvisory = advisories.find((a) => a.includes('user-global'));
		expect(userAdvisory).toBeDefined();
		expect(
			userAdvisory
				?.replace(/\\/g, '/')
				.includes('.opencode/skills/swarm-pr-review/SKILL.md'),
		).toBe(true);
		expect(userAdvisory).toContain('delete the stale user-global copy');
	});

	test('fail-open: missing canonical returns no advisories', async () => {
		const emptyPackage = makeTempRoot('sw2601-empty-');
		const project = makeTempRoot('sw2601-emptyproj-');
		_internals.resolvePackageRoot = () => emptyPackage;
		const advisories = await ensurePrWorkflowSkillContractsFresh(
			project,
			'PR_FEEDBACK',
		);
		expect(advisories).toEqual([]);
	});

	test('PR_FEEDBACK maps to the swarm-pr-feedback skill', async () => {
		const packageRoot = makeTempRoot('sw2601-fb-');
		const canonical = path.join(
			packageRoot,
			'.opencode',
			'skills',
			'swarm-pr-feedback',
			'SKILL.md',
		);
		const body = '# feedback canonical\n';
		writeSkill(canonical, body, skillContractDigest(body));
		const project = makeTempRoot('sw2601-fbproj-');
		const installed = path.join(
			project,
			'.swarm',
			'bundled-skills',
			'swarm-pr-feedback',
			'SKILL.md',
		);
		writeSkill(installed, '# stale feedback copy\n');
		_internals.resolvePackageRoot = () => packageRoot;
		_internals.syncBundled = async () => {
			fs.mkdirSync(path.dirname(installed), { recursive: true });
			fs.copyFileSync(canonical, installed);
		};

		const advisories = await ensurePrWorkflowSkillContractsFresh(
			project,
			'PR_FEEDBACK',
		);
		expect(advisories.length).toBe(1);
		expect(advisories[0]).toContain('swarm-pr-feedback');
		expect(
			advisories[0]
				.replace(/\\/g, '/')
				.includes('.swarm/bundled-skills/swarm-pr-feedback/SKILL.md'),
		).toBe(true);
	});

	test('seam default: resolvePackageRoot() covers every stamped skill canonical', () => {
		for (const slug of STAMPED_PR_WORKFLOW_SKILLS) {
			const file = path.join(
				_internals.resolvePackageRoot(),
				'.opencode',
				'skills',
				slug,
				'SKILL.md',
			);
			expect(fs.existsSync(file)).toBe(true);
		}
	});

	test('digest contract pin: the repo canonical body hashes to its stamped frontmatter value', () => {
		const canonical = path.join(
			originalInternals.resolvePackageRoot(),
			'.opencode',
			'skills',
			'swarm-pr-review',
			'SKILL.md',
		);
		const { frontmatter, body } = splitSkillFrontmatter(
			fs.readFileSync(canonical, 'utf8'),
		);
		// The stamp was written by the independent stamping script; equality
		// here pins the shared digest implementation to the shipped contract.
		expect(skillContractDigest(body)).toBe(readSkillContractStamp(frontmatter));
	});

	test('package-root walk resolves BOTH module layouts (issue #2601 PRR-001)', () => {
		// Bundle-shaped: the module executes from <pkg>/dist/index.js, one
		// level below the package root. Source-shaped: src/services/, two
		// levels deep. The old '..','..' arithmetic was only correct for the
		// source shape; the walk must resolve the package root for both.
		const pkg = makeTempRoot('sw2601-bunpkg-');
		fs.writeFileSync(path.join(pkg, 'package.json'), '{}', 'utf8');
		fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
		fs.mkdirSync(path.join(pkg, 'src', 'services'), { recursive: true });
		expect(nearestPackageRootFrom(path.join(pkg, 'dist'))).toBe(pkg);
		expect(nearestPackageRootFrom(path.join(pkg, 'src', 'services'))).toBe(pkg);
		// A layout with no package.json ancestor is undefined (fail-open
		// fallback territory), and the walk is bounded.
		const orphan = makeTempRoot('sw2601-orphan-');
		expect(nearestPackageRootFrom(orphan)).toBeUndefined();
	});

	test('seam default resolves home from the platform env var (issue #2601 PRR-008)', () => {
		// Restore the DEFAULT resolver: this suite's beforeEach points the
		// seam at a temp home, which would bypass the env-var branch under
		// test.
		_internals.resolveUserGlobalHome = originalInternals.resolveUserGlobalHome;
		const originalUserProfile = process.env.USERPROFILE;
		const originalHome = process.env.HOME;
		try {
			if (process.platform === 'win32') {
				process.env.USERPROFILE = 'E:/sw2601-fake-profile';
				delete process.env.HOME;
				expect(_internals.resolveUserGlobalHome()).toBe(
					'E:/sw2601-fake-profile',
				);
			} else {
				process.env.HOME = '/sw2601-fake-home';
				expect(_internals.resolveUserGlobalHome()).toBe('/sw2601-fake-home');
			}
		} finally {
			if (originalUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = originalUserProfile;
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
		}
	});
});
