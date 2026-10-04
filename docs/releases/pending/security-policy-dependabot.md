# Security policy and Dependabot coverage

## What

Adds the two repository-hygiene files the project was missing:

- **`SECURITY.md`** — a coordinated-disclosure policy. Reports go through GitHub
  Security Advisories rather than public issues. The "in scope" list is written
  for this plugin's actual trust position: it runs inside another agent host,
  writes to your project, and spawns subprocesses, so the relevant classes are
  write-scope escape, command execution, secret exposure, untrusted external
  skill/content ingestion, and plugin load-path compromise. It points at the
  actual implementation files for each so a reporter can self-scope.
- **`.github/dependabot.yml`** — weekly updates for `npm` (root, dev
  dependencies grouped into a single PR) and `github-actions`, so pinned action
  SHAs and runtime dependencies are tracked automatically.

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
  65. The remaining 104 HIGH findings are false positives in the scanner's
  heuristics — matched against string literals, regex source, and TypeScript type
  annotations in a static-analysis plugin — and are reported upstream in
  [hashgraph-online/hol-guard#3531](https://github.com/hashgraph-online/hol-guard/issues/3531).
  No repo-owned suppression file is added, because the catalog's scan runs with
  `trust_repository_policy: false` and would ignore it.
- Dependabot will open PRs against a repository with a merge queue. Expect the
  first few to be reviewed like any other change rather than auto-merged.
