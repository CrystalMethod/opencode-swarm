# Repo-local Maven/Gradle wrapper detection for Java test frameworks

## What changed

`selectTestFramework` in `src/lang/backends/java.ts` now prefers repo-local
build-tool wrappers over PATH-based binary detection:

- The wrapper checks run first: `./gradlew`, then `./mvnw`, before falling back
  to the existing default registry-driven selection (which probes for the
  `mvn`/`gradle` binaries).
- Both wrapper checks are Windows-aware: `resolveMvnwCommand` prefers
  `mvnw.cmd` on Windows when present (else `./mvnw`); `resolveGradlewCommand`
  prefers `gradlew.bat` on Windows when present (else `./gradlew`). Both
  helpers share a `wrapperExists(dir, name)` predicate backed by
  `fs.existsSync` — no exception-based control flow.
- Gradle wins precedence over Maven when both wrappers are present (Gradle can
  wrap Maven repos too) — this precedence was already true before and is
  preserved.

## Why

Java/Maven/Gradle test-framework detection previously relied solely on the
`mvn`/`gradle` binaries being resolvable via a PATH probe (`which`/`where`).
That probe can fail in environments where a version manager (e.g. mise, asdf)
shims the binary via shell-rc-level PATH injection that is not inherited by
every host process. Wrapper scripts are committed to the repo and do not depend
on PATH state at all, so checking for the wrapper file first is more robust.

## Migration

No breaking changes. Projects that ship a wrapper now resolve to it; projects
without a wrapper fall through to the previous PATH-based behavior unchanged.

## Known caveats

- This fix only resolves detection for projects that ship a Maven or Gradle
  wrapper (the common/standard convention). Projects with no wrapper file that
  rely purely on a PATH-resolvable `mvn`/`gradle` binary are **not** covered by
  this fix and may still be affected by the underlying PATH-probe fragility
  described above — that remains a separate, unresolved issue.