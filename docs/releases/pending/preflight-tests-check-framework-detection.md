# Preflight tests-check reaches real language-backend framework detection

## What changed

`runTestsCheck` in `src/services/preflight-service.ts` no longer always invokes
the test runner with an empty file list under the default `'convention'` scope:

- Previously the check called the test runner with an empty file/target list.
  The test runner's safety guard requires a non-empty list for that scope and
  returns `'no framework detected'` immediately when it is empty — the guard
  fired before the test runner ever reached its language-backend detection
  logic.
- `runTestsCheck` now calls the already-exported language-backend detection
  function directly first. If it detects a real framework, the check reports
  that framework was detected (informational pass) **without** executing any
  test subprocess — this intentionally avoids adding new test-execution
  behavior to the preflight path. If no framework is detected, behavior is
  unchanged from before.

## Why

Preflight's tests-check reported "no test framework detected" for every
language, universally, regardless of the actual project structure. That masked
the real per-language detection logic — including the Java/Maven/Gradle wrapper
detection fix — so preflight could never reflect what the test runner would
actually do. This fix is not specific to any one language; it applies to every
language this project supports.

## Migration

No breaking changes. The preflight tests-check still never executes a test
suite; it only reports the detected framework when one is found.

## Known caveats

- The check remains detection-only by design: when a framework is detected,
  `runTestsCheck` sets `details.detectedOnly = true` and does not execute tests.
  This result is now surfaced distinctly by both consumers: `formatPreflightMarkdown`
  (src/services/preflight-service.ts) renders a distinct informational/skip line
  ("detected only — tests not executed") instead of a plain pass, and the
  automation-status artifact consumer (src/services/preflight-integration.ts)
  records the outcome as state `'skipped'` with message `'detected only — tests not executed'`
  (not `'success'`). The detection-only result therefore does not validate that
  the suite actually passes.