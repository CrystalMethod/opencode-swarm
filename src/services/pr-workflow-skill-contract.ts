/**
 * Runtime verification of the PR-workflow skill contract (issue #2601).
 *
 * The `swarm-contract-digest` stamp (see src/config/skill-contract-digest.ts)
 * marks the shipped canonical skill bodies. Before #2601 the stamp had no
 * runtime consumer: MODE gate activation and the auto-resume wake path loaded
 * `.swarm/bundled-skills/<slug>/SKILL.md` (and the host could resolve the slug
 * to a user-global copy) without ever comparing the installed copy against the
 * shipped source — a stale copy that predates the verdict vocabulary bridge
 * mechanically wedged the terminal gate with no error naming the cause.
 *
 * This service is the runtime half: detect staleness, heal the bundled copy by
 * re-running the existing bounded sync, surface a loud actionable advisory
 * naming BOTH the stale path and the canonical source, and never block
 * activation or the wake loop (fail-open by design — detection, not gating).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBundledProjectSkillsIfMissingAsync } from '../config/bundled-skills.js';
import {
	skillContractDigest,
	splitSkillFrontmatter,
} from '../config/skill-contract-digest.js';
import type { PrWorkflowMode } from '../hooks/pr-workflow-gate.js';
import { withTimeout } from '../utils/timeout.js';
import { advisoryWarn } from './warning-buffer.js';

/** Stamped skill owning each mode's runtime protocol. */
export const PR_WORKFLOW_MODE_SKILL: Record<PrWorkflowMode, string> = {
	PR_REVIEW: 'swarm-pr-review',
	PR_FEEDBACK: 'swarm-pr-feedback',
};

/** Activation budget mirrors the init-time sync ceiling (src/index.ts). */
export const SKILL_CONTRACT_ACTIVATION_BUDGET_MS = 2_000;
/**
 * Wake budget is tighter: the wake path also owes the continuation prompt
 * inside its existing wakeTimeoutMs/boundaryWatchdogMs envelopes.
 */
export const SKILL_CONTRACT_WAKE_BUDGET_MS = 750;

const MAX_ADVISORIES = 8;

/**
 * Test seams (AGENTS.md invariant 7: `_internals` DI over `mock.module`).
 * Restore in afterEach; see the sibling precedents in bundled-skills.ts.
 */
export const _internals: {
	resolvePackageRoot: () => string;
	resolveUserGlobalHome: () => string;
	syncBundled: (
		projectDirectory: string,
		packageRoot: string,
		quiet: boolean,
	) => Promise<void>;
} = {
	resolvePackageRoot: () =>
		path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
	/**
	 * Env-var-aware home resolution: os.homedir() ignores process.env
	 * entirely, so the env vars are consulted FIRST to keep the user-global
	 * arm testable against a temp HOME (mirrors the drift-check precedent).
	 */
	resolveUserGlobalHome: () => {
		if (process.platform === 'win32') {
			const userProfile = process.env.USERPROFILE?.trim();
			if (userProfile) return userProfile;
		} else {
			const home = process.env.HOME?.trim();
			if (home) return home;
		}
		return os.homedir();
	},
	syncBundled: (projectDirectory, packageRoot, quiet) =>
		syncBundledProjectSkillsIfMissingAsync(
			projectDirectory,
			packageRoot,
			quiet,
		),
};

function readBodyDigestOrNull(file: string): string | undefined {
	let content: string;
	try {
		content = fs.readFileSync(file, 'utf8');
	} catch {
		return undefined;
	}
	return skillContractDigest(splitSkillFrontmatter(content).body);
}

/**
 * Verify the mode's stamped skill copies against the shipped canonical and
 * heal the bundled copy. Returns actionable advisories (also routed through
 * `advisoryWarn`); [] on a clean host. Fail-open: any internal error becomes
 * a single advisory and never throws.
 */
export async function ensurePrWorkflowSkillContractsFresh(
	directory: string,
	mode: PrWorkflowMode,
	options: { budgetMs?: number } = {},
): Promise<string[]> {
	const advisories: string[] = [];
	const emit = (message: string) => {
		advisories.push(message);
		advisoryWarn(message);
	};
	try {
		const slug = PR_WORKFLOW_MODE_SKILL[mode];
		const packageRoot = _internals.resolvePackageRoot();
		const canonicalPath = path.join(
			packageRoot,
			'.opencode',
			'skills',
			slug,
			'SKILL.md',
		);
		const canonicalDigest = readBodyDigestOrNull(canonicalPath);
		if (!canonicalDigest) {
			// Nothing shipped to verify against (e.g. fixture package root):
			// fail open with no advisory.
			return advisories;
		}

		const installedPath = path.join(
			directory,
			'.swarm',
			'bundled-skills',
			slug,
			'SKILL.md',
		);
		const installedExisted = fs.existsSync(installedPath);
		const installedBefore = readBodyDigestOrNull(installedPath);
		if (!installedExisted) {
			// Materialization, not staleness: this project's bundled copy was
			// never written (the init-time sync is fail-open and the command
			// path has not run), or it disappeared after activation. The
			// architect's MODE stub references this exact private path, so a
			// copy that cannot be restored must be REPORTED, not silently
			// skipped: attempt the bounded materialization at every entry
			// point (activation and wake alike), and record an actionable
			// advisory naming the missing path and the canonical source when
			// the copy is still absent afterwards.
			let materialized = false;
			try {
				await withTimeout(
					_internals.syncBundled(directory, packageRoot, true),
					options.budgetMs ?? SKILL_CONTRACT_ACTIVATION_BUDGET_MS,
					new Error(
						`skill-contract materialization exceeded its budget for ${slug}`,
					),
				);
			} catch {
				// The outcome check below reports a failed materialization.
			}
			materialized = readBodyDigestOrNull(installedPath) === canonicalDigest;
			if (!materialized) {
				emit(
					`bundled skill '${slug}' is missing from this project and could not be materialized: ${installedPath} was not found and the bounded re-sync from the shipped canonical ${canonicalPath} (digest ${canonicalDigest}) did not restore it — the architect's MODE instructions reference that exact path; re-run the /swarm pr-review or /swarm pr-feedback command, or restart the host to re-sync .swarm/bundled-skills`,
				);
			}
		} else if (installedBefore !== canonicalDigest) {
			let healed = false;
			try {
				await withTimeout(
					_internals.syncBundled(directory, packageRoot, true),
					options.budgetMs ?? SKILL_CONTRACT_ACTIVATION_BUDGET_MS,
					new Error(`skill-contract re-sync exceeded its budget for ${slug}`),
				);
			} catch {
				// The sync itself fail-opens (and advisory-warns) internally;
				// the stale verdict below reports the outcome either way.
			}
			const installedAfter = readBodyDigestOrNull(installedPath);
			healed = installedAfter === canonicalDigest;
			emit(
				`stale skill contract detected at ${mode} activation for '${slug}': the installed copy ${installedPath} (digest ${installedBefore ?? '<missing>'}) does not match the shipped canonical ${canonicalPath} (digest ${canonicalDigest}) — ` +
					(healed
						? 'refreshed from the canonical source'
						: 'still stale after the bounded re-sync; repair by re-running the /swarm pr-review or /swarm pr-feedback command, or delete the stale .swarm/bundled-skills directory'),
			);
		}

		// User-global arm: ADVISORY-ONLY. User-global trees are NEVER written
		// (the read-only invariant documented on the drift-check detector); a
		// stale copy there can shadow host skill resolution, so surface the
		// executable repair instead.
		const home = _internals.resolveUserGlobalHome();
		for (const relativePath of [
			path.join('.opencode', 'skills', slug, 'SKILL.md'),
			path.join('.claude', 'skills', slug, 'SKILL.md'),
		]) {
			const userPath = path.join(home, relativePath);
			const userDigest = readBodyDigestOrNull(userPath);
			if (userDigest === undefined || userDigest === canonicalDigest) continue;
			emit(
				`stale user-global copy of '${slug}' shadows the canonical skill: ${userPath} (digest ${userDigest}) differs from the repository copy ${canonicalPath} (digest ${canonicalDigest}) — delete the stale user-global copy`,
			);
		}

		return advisories.slice(0, MAX_ADVISORIES);
	} catch (error) {
		const message = `skill-contract verification failed (fail-open): ${error instanceof Error ? error.message : String(error)}`;
		advisoryWarn(message);
		return [message];
	}
}
