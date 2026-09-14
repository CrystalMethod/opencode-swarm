/**
 * Runtime reachability dispositions for the six bundled skills named by issue
 * #2672 (`ci-failure-batching`, `gate-attribution`, `merge-queue-readiness`,
 * `skill-edit-validation`, `worktree-retry-cleanup`, `parallel-work-check`).
 *
 * A disposition is a MEASURED claim, not a text-search guess:
 * - `reachable` means the skill has a real runtime consumer — a shipped
 *   protocol body carrying the `file:.swarm/bundled-skills/<slug>/SKILL.md`
 *   read directive the agent follows at runtime (consumers may load skills
 *   indirectly; registration + runtime resolution is what is traced) — and the
 *   slug is present in every shipping inventory (`BUNDLED_PROJECT_SKILLS`,
 *   `package.json#files`, the package-smoke allowlist).
 * - `retired` means the slug was EXPLICITLY removed from every inventory and
 *   no live consumer reference remains.
 *
 * Deletion is never driven by a missing literal search hit: the consumer
 * controls in `tests/unit/skills/bundled-skill-consumer-controls.test.ts` fail
 * when a skill is neither reachable nor explicitly retired with full inventory
 * parity, so a vanishing text reference forces either a discovered consumer or
 * a deliberate retirement — never a silent drop.
 */

export interface BundledSkillDisposition {
	disposition: 'reachable' | 'retired';
	/** Repo-relative consumer files carrying the runtime read directive. */
	consumers: string[];
	/** What the consumer path is (measured, with the consuming workflow). */
	note: string;
}

export const BUNDLED_SKILL_DISPOSITIONS: Record<
	string,
	BundledSkillDisposition
> = {
	'ci-failure-batching': {
		disposition: 'reachable',
		consumers: ['.opencode/skills/swarm-pr-feedback/SKILL.md'],
		note: 'PR_FEEDBACK batch-collection protocol: swarm-pr-feedback directs the agent to read the private runtime copy for the 6-step CI failure batching protocol.',
	},
	'gate-attribution': {
		disposition: 'reachable',
		consumers: ['.opencode/skills/execute/SKILL.md'],
		note: 'EXECUTE set-dispatch verdict attribution: execute directs the agent to read it when reviewer/test_engineer verdict rows must be attributed to plan tasks.',
	},
	'merge-queue-readiness': {
		disposition: 'reachable',
		consumers: [
			'.opencode/skills/swarm-ci-monitor/SKILL.md',
			'.claude/skills/commit-pr/SKILL.md',
		],
		note: 'Optional pre-queue merge-group CI simulation: swarm-ci-monitor (opencode runtime) and the commit-pr adapter (claude runtime) both direct the agent to read the full protocol before queueing.',
	},
	'skill-edit-validation': {
		disposition: 'reachable',
		consumers: [
			'.claude/skills/commit-pr/SKILL.md',
			'.claude/skills/editing-skills/SKILL.md',
		],
		note: 'Content-assertion sweep for SKILL.md wording changes: commit-pr requires it before committing skill edits and editing-skills requires it before push (claude runtime adapters).',
	},
	'worktree-retry-cleanup': {
		disposition: 'reachable',
		consumers: ['.opencode/skills/execute/SKILL.md'],
		note: 'Re-dispatch hygiene: execute directs the agent to read it before re-dispatching a coder for a task that already has a lane.',
	},
	'parallel-work-check': {
		disposition: 'reachable',
		consumers: [
			'.opencode/skills/swarm-implement/SKILL.md',
			'.opencode/skills/swarm-pr-review/SKILL.md',
		],
		note: 'Parallel-work guard: swarm-implement reads it before lane binding and swarm-pr-review reads it before dispatching review lanes (also referenced by name in swarm-pr-feedback).',
	},
};
