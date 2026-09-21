# GitLab as a first-class forge provider alongside GitHub (issue #2733)

## What

- New provider core `src/providers/forge-provider.ts`: shape-based forge detection (`github.com`; `gitlab.com` and any `gitlab.`-prefixed self-hosted host), host-aware remote parsing that preserves the instance host and GitLab nested-namespace owners, canonical PR/MR + issue URL builders, a provider-aware canonicalizer (`canonicalForgePrUrl`) that replaces the four duplicated `canonicalGitHubPrUrl` implementations byte-compatibly, fail-closed provider selection (`resolveProviderSelection`), and honest capability reporting (`getProviderCapabilities`: GitLab reports `statusCheckRollup`/`reviewDecision`/`mergeStateStatus` as unavailable — never fabricated).
- Shared host guards extracted to `src/providers/host-guards.ts` (identical private-host/IDN/zero-network/control-char implementations, re-exported by url-security so its API is unchanged); `validateAndSanitizeGithubUrl` now accepts GitLab MR/issue URL shapes with every security control applied identically, and its path-shape error messages are provider-neutral.
- GitLab MR/issue URLs flow through `/swarm pr-review`, `pr-feedback`, `pr subscribe`/`pr unsubscribe`, `ci-monitor` reference resolution, issue ingestion, publication recording (`record_issue_publication` args widened), the subscription store schema (including nested-namespace `repoFullName`), event routing/feedback-queue/workflow-gate canonical matching, auto-subscribe (`glab mr create` output), and persisted issue references.
- New hardened `glab` resolver `src/utils/glab-executable.ts` mirroring the gh resolver contract (env-only `OPENCODE_SWARM_GLAB_BINARY` override, platform-before-PATH absolute candidates, version-probed acceptance `^glab version \d+\.\d+`, 250 ms/probe + 1 s budget, never-throws, cached), with a gh↔glab structural parity ratchet test so future gh hardening cannot land without its glab mirror.
- New optional `forge` config section (`provider: github|gitlab|auto` default `auto`, `base_url` for self-hosted GitLab). `base_url` passes through the same guards as any forge URL — it is never a trust whitelist; ambiguous remotes (mixed, generic-host, none) fail closed demanding explicit configuration.
- Architect CI_MONITOR guidance notes the GitLab capability boundary (verify via `glab api .../merge_requests/<iid>` `merge_status` + approvals endpoint instead of GitHub-synthesized fields).

## Why

Issue #2733: every PR/issue workflow integrated exclusively with GitHub through the `gh` CLI; GitLab URLs and remotes were rejected at every integration point (validator regex, parser regexes, canonical URL templates, four duplicated canonicalizers, publication/subscription schemas, auto-subscribe pattern, and the hardened binary resolver knew only `gh`). Teams on gitlab.com or self-hosted GitLab could not use these workflows at all.

## Migration

Downgrade note: subscription records and issue references for **generic self-hosted GitLab instances** carry a `forge` declaration that older plugin releases (<= 7.184.17) reject as an unknown key — before downgrading from a release containing this change, unsubscribe from any self-hosted GitLab MR (`/swarm pr unsubscribe <mr-url>`) or remove `.swarm/pr-monitor/` state. GitHub subscriptions are unaffected. Follow-up issue #2882 also tracks the deferred canonical-wrapper threading and a narrow monitor store-write-refusal edge for declared generic hosts.

No breaking changes for GitHub users: every GitHub-path output (canonical URLs, GHE/proxy bare-number fallback, error semantics for GitHub-shape mistakes) is byte-identical. Sanctioned contract changes (tests updated in the same PR): `pr-subscriptions` schema now accepts GitLab MR `prUrl` shapes and nested-namespace `repoFullName`; `record_issue_publication` accepts GitLab MR URLs; `pr-unsubscribe`'s test seam grew `resolveCanonicalPrUrl`. Schema artifact regenerated (`opencode-swarm.schema.json`, `docs/configuration.md` forge section).

## Caveats

- Honest-unavailable scope: until the tracked follow-up lands, GitLab subscriptions skip live polling with an explicit unavailable marker — the three GitHub-synthesized fields AND non-synthesized live MR data (title/description/comments) are unavailable for GitLab rather than fabricated. Reference resolution, publication, subscription storage, event routing, and gates operate on GitLab refs today.
- `forge.provider: 'github'` combined with `base_url` is rejected as a configuration conflict (GitHub's base is fixed).
