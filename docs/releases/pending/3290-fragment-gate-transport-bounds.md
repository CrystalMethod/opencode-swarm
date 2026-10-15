---
issue: 3290
---

# Fragment gate: path-list transport, listing integrity, and job bounds

## What

The pr-standards fragment-gate arms now transport their changed/added path
lists to the classifier in a newline-safe framing, the dispatched arm validates
its files listing, and the job is bounded.

## Why

Both arms moved path lists as line-delimited text. `core.quotePath=false` only
stops git from C-quoting non-ASCII bytes: a path containing a quote, backslash,
or control character still arrived C-quoted and matched no path class (the PR
was waved through as "not user-visible"), and a path containing a newline could
not survive the transport at all — while the quality gate's own `git diff -z`
view classified the same path as user-visible, so two required checks could
disagree about the same change. The dispatched arm also made two independent
files-API listings (a push between them produced split-brain lists), never
checked the listing against the PR's `changed_files` count (the API truncates
beyond 3000 files), and never re-asserted its head guard after listing. The
pr-standards job also lacked a `timeout-minutes`, its pull_request checkout
persisted the job token for PR-authored code to read, and the classifier's
stdin read was unbounded.

## Change

`scripts/check-pending-fragment.ts --print-requirement` gains
`--paths-format <newline|nul|jsonl>` with `--changed-file`/`--added-file`
inputs (byte-bounded at 4 MiB, stream-bounded on stdin; exit 2 on undecodable
or oversized input). The pull_request arm feeds `git diff -z` temp files; the
dispatched arm materializes ONE `gh api --paginate ... --jq '.[]'` listing,
fails closed when the entry count differs from the PR's `changed_files` or the
head moved after the guard, and derives both lists as JSON-encoded paths. The
job declares `timeout-minutes: 15` and both checkouts set
`persist-credentials: false`. The legacy newline stdin mode and `--added`
flags are unchanged (`release-and-publish.yml` depends on them), and the
recorded workflow hash in `docs/ci/required-check-evidence.json` is refreshed
in the same change.

## Behavior change

A changed path that git C-quotes (or that contains a newline) now reaches the
same verdict in both pr-standards arms as in the quality gate. A truncated
files listing or a PR head that moves during the dispatched validation fails
closed with an explicit error instead of classifying a partial snapshot. An
input stream larger than 4 MiB makes the classifier exit 2 (unusable) instead
of reading unbounded input.

## Migration

None. The classifier's legacy invocation shapes keep working; the new
`--paths-format` mode is additive.
