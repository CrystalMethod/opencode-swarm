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
- The submission body is severity-grouped (CRITICAL → LOW, non-empty groups
  only) with finding ids, locations, and coverage disclosure (partial coverage
  dimensions or trigger-evaluation degradations). Reviewer-behavior
  constraints: findings already present in prior PR comments are skipped, a
  repeated finding consolidates to one comment, identical locations
  consolidate, and inline comments are capped at 20 with a disclosed
  truncation marker. An all-posted run refuses as an idempotent no-op instead
  of duplicating the summary.

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
  different session than the workflow session is not caught by the
  session-scoped abort match.
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

## Verification

- Frozen acceptance checks C1-C4 (RED at base → GREEN) and C5 (PRESERVING,
  GREEN/GREEN) under the issue-tracer red checkpoint; anchor published on
  issue #3096.
- New suites: `tests/unit/tools/pr-review-submission.test.ts`,
  `tests/unit/tools/pr-review-submission-transport.test.ts`,
  `tests/unit/pr-review/render-review-body.test.ts`.
- `bun run scripts/check-tool-registration.ts`, `bun run check:bare-spawn`,
  `bun run check:test-file-cap`, `bun run typecheck`, biome clean on touched
  files; sibling controller/config suites green.
