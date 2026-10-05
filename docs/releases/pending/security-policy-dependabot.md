# Security policy and Dependabot coverage

## What

Adds the two repository-hygiene files the project was missing:

- **`SECURITY.md`** — a coordinated-disclosure policy. Reports go through GitHub
  Security Advisories rather than public issues. The "in scope" list is written
  for this plugin's actual trust position: it runs inside another agent host,
  writes to your project, and spawns subprocesses, so the relevant classes are
  write-scope escape, command execution, secret exposure, untrusted external
  skill/content ingestion, and plugin load-path compromise. Each class points at
  the implementing file(s) so a reporter can self-scope.
- **`.github/dependabot.yml`** — weekly updates for `bun` (root, dev
  dependencies grouped into a single PR) and `github-actions`, so pinned action
  SHAs and runtime dependencies are tracked automatically. The `bun` ecosystem
  is used rather than `npm` because this project is Bun-managed (`bun.lock`, no
  `package-lock.json`); the `npm` ecosystem cannot update a `bun.lock`, and CI
  runs `bun install --frozen-lockfile`, so an npm-ecosystem update would fail.
  `@opencode-ai/*` is excluded: the host contract is pinned on purpose
  (`tests/helpers/host-contract-v1_18_3.ts` asserts the exact installed
  version), so those bumps require a manual host-contract re-verification.

## Why

Both were surfaced by the `plugin-scanner` scan that gates the project's
listing in the [awesome-ai-plugins](https://github.com/hashgraph-online/awesome-ai-plugins)
catalog: `SECURITY.md found` and `Dependabot configured for automation surfaces`
both scored zero. They are worth having on their own merits — a plugin that
holds this much trust on a user's machine should publish how to report a problem
with it, and pinned action SHAs are only useful if something watches them.

## Migration

None. Both files are additive; no runtime, tool, or configuration surface is
touched.

## Caveats

- This does **not** clear the catalog's required scan gate. The project's
  current scan is 52/100 against a required 80, and these two files take it to
  65. The 104 HIGH findings are false positives in the scanner's
  heuristics — matched against string literals, regex source, and TypeScript type
  annotations in a static-analysis plugin — and are reported upstream in
  [hashgraph-online/hol-guard#3531](https://github.com/hashgraph-online/hol-guard/issues/3531).
  The count is unchanged from base: an intermediate revision of SECURITY.md
  tripped one extra match of the same class, and the wording now shipped does
  not. No repo-owned suppression file is added, because the catalog's scan runs
  with `trust_repository_policy: false` and would ignore it.
- Dependabot will open PRs against a repository with a merge queue. Expect the
  first few to be reviewed like any other change rather than auto-merged.
- `@opencode-ai/*` is excluded from Dependabot entirely, so no version PR — and
  no advisory-driven PR — opens for those two production packages. Dependabot
  security *alerts* still surface on the repository's Security tab; the weekly
  `host-contract-check` job is the re-verification trigger for a host bump.
