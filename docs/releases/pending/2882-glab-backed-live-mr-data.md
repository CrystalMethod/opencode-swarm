# glab-backed live MR data for GitLab PR monitoring (issue #2882)

Follow-up to the GitLab first-class provider (#2733 / PR #2884): GitLab merge
request subscriptions now get live monitoring data instead of the
honest-unavailable skip.

## What changed

- `src/git/pr.ts` ships a glab-backed MR fetch layer behind the same bounded
  subprocess runner contract as the gh path: `glab mr view <iid> -R <project>
  -F json` for MR fields, `glab api projects/<url-encoded-path>/merge_requests/<iid>`
  for merge state, `glab api .../pipelines` for pipeline verdicts, and the MR
  notes endpoint for comments (system notes excluded, bodies neutralized).
  Every spawn is array-argv with explicit cwd, ignored stdin, a 30 s timeout,
  5 MB stream caps, and a best-effort kill on settle. Declared self-hosted
  hosts are selected per-spawn via `GITLAB_HOST` (never a shell string).
- `pollSinglePr` routes GitLab subscriptions (gitlab.com shape-detected AND
  declared generic self-hosted hosts) through that path. The three
  GitHub-synthesized fields — `statusCheckRollup`, `reviewDecision`,
  `mergeStateStatus` — remain explicitly NOT AVAILABLE for GitLab and are
  never fabricated (`getProviderCapabilities` unchanged, the source of truth).
- Pipeline/CI verdicts for the MR head sha surface through the existing event
  vocabulary (`pr.ci.failed` / `pr.ci.passed`) with the existing
  `lastCheckRunSet` transition machinery; non-terminal pipeline statuses
  produce no event, and a pipelines fetch failure preserves prior CI state.
- `/swarm pr subscribe` on a GitLab MR now says live monitoring is active and
  discloses which synthesized equivalents remain unavailable.
- Deferred PR-#2884-review items landed with the polling: the four
  `canonicalGitHubPrUrl` wrappers now thread the configured forge context
  (from the subscription record's persisted declaration, or the plugin-config
  declaration on the command path) so declared generic self-hosted MR URLs
  canonicalize for event identity/dedup — subscriber matching, queue
  admission, claim, and PR_FEEDBACK activation; without a declaration every
  one of these stays fail-closed. The monitor store-write refusal no longer
  wedges on GitLab-only stores (the skip that returned before
  `clearStoreWriteRefusal` is gone; a missing glab binary is an ordinary
  environment error handled by the standard circuit-breaker accounting).
  The PR feedback loop's head evaluation is provider-aware, so oversight
  dispatch no longer silently fails closed for GitLab MRs.

## Migration note

The mixed-version downgrade caveat from #2733 still applies unchanged:
subscription records for declared generic self-hosted GitLab instances carry
a `forge` declaration that plugin releases <= 7.184.17 reject as an unknown
key. Before downgrading from any release containing #2733/#2882, unsubscribe
from self-hosted GitLab MRs (`/swarm pr unsubscribe <mr-url>`) or remove
`.swarm/pr-monitor/` state. With live polling active, losing those
subscriptions on downgrade also loses their event history — unsubscribe first.
GitHub subscriptions are unaffected.
