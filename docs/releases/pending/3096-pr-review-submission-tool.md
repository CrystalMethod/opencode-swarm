---
issue: 3096
---

# Controller-mediated, head-bound PR review submission

## What

Adds the missing `pr_review_submission` controller tool plus a pure
`renderPrReviewSubmissionBody` renderer module (Workstream C PR 1/2):

- The architect can submit a settled PR-review run to GitHub through the PR
  Review API (`POST repos/<owner>/<repo>/pulls/<n>/reviews` via the bounded gh
  transport), with the review's `commit_id` pinned to the run's exact
  `pr_head_sha` and inline comments carrying each finding's file:line identity.
- Authorization is fail-closed and additive to every existing settlement and
  gate path: the tool refuses while any PR-workflow gate is active for the
  session (submission opens only after `complete_pr_workflow` clears the gate),
  refuses when the workflow for this head was aborted at/after the run's
  settlement time, and refuses unless the trigger-eval receipt and every
  findings record bind to the declared head with at least one post_critic
  settlement record. It is architect-only — no discovery/validation child-lane
  exposure.
- The submission renders ONLY the settled post_critic records from
  findings.jsonl (the file accumulates one record per finding per boundary;
  superseded pre-critic records and critic-DISPROVED findings are never
  published, and the REQUEST_CHANGES/COMMENT event is derived from settled
  severities alone). The body is severity-grouped (strongest group first,
  non-empty groups only; dismissed findings are counted and omitted;
  non-CONFIRMED settled findings carry an explicit status marker) with
  finding ids, locations, and coverage disclosure (partial coverage
  dimensions or trigger-evaluation degradations; a corrupt coverage
  disclosure refuses instead of degrading to FULL). Reviewer-behavior
  constraints: findings whose rendered `[<id>] ` marker already appears in
  prior PR comments/reviews are skipped (anchored match — bare-id mentions
  and substring id collisions never suppress), a repeated finding
  consolidates to one comment, identical location+evidence consolidate, and
  inline comments are capped at 20 with a disclosed truncation marker; the
  body itself is capped at 60,000 characters with a disclosed truncation. An
  all-posted run refuses as an idempotent no-op instead of duplicating the
  summary.

## Why

Every PR-workflow channel except GitHub publication was already bound to the
exact `pr_head_sha`; there was no controller tool that submitted review
results to the PR, and under an active PR_REVIEW gate the read-only gh
allowlist rejects `gh pr review`/`gh api` POSTs categorically — the operator
had no sanctioned publication path at all. This closes the provenance gap at
the GitHub boundary additively, without touching any settlement, gate, or
artifact path.

## Disclosed limits

- A crashed (never aborted, never completed) run with settled artifacts still
  passes the artifact-based authorization; a submission invoked from a
  different session than the workflow session passes the gate arm vacuously
  (run ownership is not verified — the gate and abort arms are both
  session-scoped), and that session's aborts are invisible to the abort scan.
- The target repository/PR number are caller-supplied and are not bound to
  the run's artifacts (the receipt carries no repo/PR identity); GitHub's
  own commit_id-to-PR constraint is the only cross-check.
- The abort scan refuses (fail closed) when the events store exists but is
  unreadable or its retained tail is truncated; recorded aborts carrying a
  different workflow mode (e.g. PR_FEEDBACK) do not block a PR_REVIEW
  submission. Artifact-path validations return typed refusals on
  traversal-shaped run ids.
- The abort scan reads the bounded retained-events window (the same
  `readCoreEvents` tail the gate machinery itself uses); an abort scrolled out
  of that window escapes the narrowing — the same residual class as the
  crashed-run case.
- The existing-comments dedupe fetch reads one bounded page (100 items) of PR
  comments and review bodies per endpoint; larger PRs may under-dedupe, and
  the review body itself is never auto-deduped across invocations.
- GitHub's acceptance of an abbreviated (non-40-hex) `commit_id` is not
  documented; a rejection surfaces verbatim through the typed transport
  failure path.

## Skill surface

`pr_review_submission` is named in the swarm-pr-review skill's Profile A
controller-tool list (added in the feedback round).

## Verification

- Frozen acceptance checks C1-C4 (RED at base → GREEN) and C5 (PRESERVING,
  GREEN/GREEN) under the issue-tracer red checkpoint; anchor published on
  issue #3096.
- New suites: `tests/unit/tools/pr-review-submission.test.ts`,
  `tests/unit/tools/pr-review-submission-transport.test.ts`,
  `tests/unit/tools/pr-review-submission-feedback-round2.test.ts`,
  `tests/unit/pr-review/render-review-body.test.ts`.
- `bun run scripts/check-tool-registration.ts`, `bun run check:bare-spawn`,
  `bun run check:test-file-cap`, `bun run typecheck`, biome clean on touched
  files; sibling controller/config suites green.
