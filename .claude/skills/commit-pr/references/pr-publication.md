

---

# PR publication flow (issue-trace receipt, PR monitoring subscription, issue comment, commit messages)


### Issue-trace publication receipt
If this session is running an issue trace (`/swarm issue --trace`), call
`record_issue_publication` with the issue number, PR number, URL, and HEAD sha immediately
after `gh pr create` (or after `gh pr edit` / `gh pr ready` for an existing PR).
This is what lets the issue-trace workflow reach its terminal `published` state —
without it the trace stays at `publication_handoff` and is NOT considered resolved.

## Step 6a - PR monitoring subscription

After PR creation, if the project uses PR monitoring (`pr_monitor.enabled: true`
in resolved opencode-swarm config), the new PR must be subscribed for background
monitoring:

- **Automatic (default):** when `pr_monitor.auto_subscribe_on_pr_create` is
  enabled (default `true`), the subscription is created automatically after
  `gh pr create` succeeds — no command needed. Verify with `/swarm pr status`
  if in doubt.
- **Manual fallback:** when auto-subscribe is disabled or did not fire, run
  `/swarm pr subscribe <pr-url>`, which records the subscription and
  lazy-starts the polling worker.

The post-subscription monitoring protocol — event intake, triage
(fix / ask / skip), bounded-retry escalation, and terminal-state behavior —
lives in the swarm-pr-subscribe skill (`../swarm-pr-subscribe/SKILL.md`).

## Step 6.5 - Issue comment

If the PR closes an issue, post a comment on the issue. This is mandatory.

The issue comment must include:

1. the PR link
2. what changed
3. how to use it
4. migration steps or "No migration required"

Uses the same UTF-8-no-BOM file-write pattern as Step 6 above.

````powershell
$comment = @"
Fixed in PR #<pr-number>.

## What changed
- <bullet 1>
- <bullet 2>

## How to use
```json
{ "config": "example" }
```

## Migration
No migration required.
"@
$utf8NoBom = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
$issueCommentPath = Join-Path ([System.IO.Path]::GetTempPath()) "issue-comment.txt"
[System.IO.File]::WriteAllText($issueCommentPath, $comment, $utf8NoBom)
gh issue comment <issue-number> --body-file $issueCommentPath
````

If the PR merged before this was done, post the missing issue comment immediately.

## Commit messages

PowerShell parens/brackets/backticks/dollar-signs in `git commit -m "..."` fail. Use the same UTF-8-no-BOM file-write pattern (see Step 6), then `git commit -F <file>`.
