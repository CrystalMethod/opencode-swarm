# test_runner: honest spawn-failure classification, Windows Gradle launcher, and accurate targets-only rejection

## What changed

`test_runner` now distinguishes a test-process LAUNCH failure from a test REGRESSION, launches the Gradle wrapper safely on Windows, and rejects targets-only discovery-scope calls up front with an accurate message (issues #3039, #3040, #3041; follow-ups to the PR #3021 review).

- A failed process spawn (`proc.spawnError` — executable not found, bad cwd, EACCES) is now reported as `outcome: "error"` with `Test command failed to launch: <reason>` instead of `outcome: "regression"` / "Tests failed with 0 failures". Previously an agent could mistake a missing executable for a product test failure and start "fixing" tests for an environment problem. The classification lives in the single `runTests` site and applies to every framework.
- On Windows, a project's `gradlew.bat` wrapper is now launched through the same contained `cmd.exe` launcher PR #3021 introduced for Maven (`resolveContainedWindowsBatchCommand`). Bun resolves a bare executable name against PATH only — never the spawn `cwd` — so the previous bare `gradlew.bat` argv could never start; Windows Gradle projects now actually run. Tokens the launcher cannot quote safely (a `--tests` argument ending in a backslash, or containing a cmd.exe metacharacter) fall back to plain `gradle` from PATH; POSIX behavior is unchanged.
- `test_runner` calls with `targets` but no `files` in the `convention`, `graph`, and `impact` scopes are now rejected up front by the scope guard with one accurate message (`scope "convention", "graph", and "impact" require a non-empty files array - targets only filter which tests run and cannot substitute for files (omitting files causes unsafe full-project discovery)`). Previously such calls passed the guard and died downstream in files-centric validation with the misleading "Provided files contain ..." text even though no files were provided. Targets remain a filter alongside a `files` selection (for example Maven `-Dtest`), and files+targets calls are unaffected. Targets-only calls never successfully ran before — command builders for file-based frameworks (bun, jest, vitest, mocha, pytest, ...) ignore `targets`, so allowing them would silently run the full suite.

## Why

Found during the swarm-pr-review of PR #3021: the Maven wrapper fix exposed the same three latent defects for every other framework. The `bunSpawn` contract reports process-creation failures as a `spawnError` value (never a throw); `test_runner` was the one bounded runner that never read it.

## Notes

- The `targets` schema description now states explicitly that targets filter a files-driven selection and cannot drive discovery alone.
