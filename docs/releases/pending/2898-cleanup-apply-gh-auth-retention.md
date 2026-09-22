---
issue: 2898
---

# Release fragment cleanup: authenticated apply step, class guard, retention trend (issue #2898)

The release workflow's `cleanup-release-fragments` job had failed on every
release since 2026-09-06: the "Validate and apply fragment cleanup" step ran
`release-notes-fragments.mjs apply-cleanup` with only `TAG_NAME` in its step
env, so the script's first `gh api` call exited with `To use GitHub CLI in a
GitHub Actions workflow, set the GH_TOKEN environment variable`. Because
`publish-npm` does not depend on the cleanup job, npm publishes stayed green
and the failure was invisible; `docs/releases/v*.md` and the manifests froze
at v7.166.4.

What changed:

- The "Validate and apply fragment cleanup" step now carries
  `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` and
  `GITHUB_REPOSITORY: ${{ github.repository }}`, byte-matching the adjacent
  "Open cleanup PR" step. The next release should materialize the archive and
  open the deterministic cleanup PR as documented.
- `scripts/release-notes-fragments.mjs` exports `MODES_REQUIRING_GH` — exactly
  the CLI modes whose execution path reaches the `gh` binary
  (`update-pr`, `update-release`, `prepare-cleanup`, `apply-cleanup`).
- New workflow-shape test
  `tests/unit/scripts/ci/release-fragments-gh-auth-shape-2898.test.ts` scans
  `release-and-publish.yml` and `drift-check.yml`, derives the guarded mode
  list from the exported constant, and fails if any step invoking a
  gh-dependent mode lacks `GH_TOKEN` in its effective env — reintroducing the
  defect class now fails CI, with an in-memory mutation pair proving the
  collector discriminates.
- `verify-retention` now reports the retention trend: 14-day add rate from
  `git log --diff-filter=A` over `docs/releases/pending`, projected
  days-to-limit against the 750-fragment cap, and a `::warning::` annotation
  when fewer than 30 days remain, so the next retention wall is visible weeks
  ahead instead of reddening drift CI unannounced.
- New `release-health-summary` job in the release workflow runs on every
  release regardless of the cleanup result (`if: always()`), reports the
  release-job conclusions to the run summary, and emits an `::error::`
  annotation when the cleanup job concludes anything other than success or
  skipped — a failing cleanup is now visible without opening the job log.
