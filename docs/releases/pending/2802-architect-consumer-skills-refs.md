---
issue: 2802
title: Architect prompt no longer induces dead SKILLS references in consumer projects
---

## What changed

In consumer projects (any project other than the opencode-swarm source repo),
the architect agent sometimes emitted a coder delegation containing
`SKILLS: file:.claude/skills/engineering-conventions/SKILL.md` — a path that
only exists in the opencode-swarm source repository. The delegation gate then
correctly blocked the dispatch with `Blocked invalid SKILLS reference ...:
skill file does not exist`, and the coder task could not run until the
architect re-delegated (#2802).

The architect system prompt now:

- marks `writing-tests` / `engineering-conventions` as examples from the
  opencode-swarm source repository, not universal defaults, and requires
  confirming the skill file exists in the CURRENT project before emitting a
  `file:` reference (`SKILLS: none` otherwise);
- replaces all six copyable literal example `SKILLS:` /
  `SKILLS_USED_BY_CODER:` lines (and the Step-4 forwarding prose example) with
  a `<project-skill>` placeholder plus a NOTE pointing at the hook's
  auto-discovered skill list.

The fail-closed gate itself is unchanged: a delegation carrying a dead
reference is still blocked (including with `skillPropagation.enabled: false`),
by design.

## Consumer impact

Consumer projects stop seeing copy-induced dead-reference blocks on coding
delegations. Projects that DO ship a skill reference it exactly as before; the
rewritten guidance also correctly steers architects to bundled skills that
materialize under `.swarm/bundled-skills/<slug>/SKILL.md` (those paths are
current-project-valid).

Residual risk (unchanged in kind, reduced in likelihood): a model could still
copy the placeholder token itself verbatim; the gate fail-closes on that too.
A new guardrail test (`tests/unit/agents/architect-consumer-skills-refs-2802.test.ts`)
fails on any future reintroduction of repo-specific literal example lines, on
loss of the existence-check guidance, or on loss of the placeholder /
`SKILLS_USED_BY_CODER` forwarding examples.

## References

- Issue #2802
- Pinned tests re-pointed: `tests/unit/agents/skills-propagation.test.ts`
