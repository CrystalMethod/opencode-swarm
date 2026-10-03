## test_runner detects and runs nested Maven modules

`test_runner` failed to detect Maven at all when the project root did not itself
contain a `pom.xml` and the Maven module lived in a nested directory (for
example `backend/pom.xml`). Root-level framework detection found nothing, so the
run fell through to no framework and the nested module was never exercised.

A new exported resolver, `resolveMavenModuleDir(root, files?)`, now backs a
last-resort nested fallback that runs **only after every existing root-level
detector returns no match**, and only when the project root itself has no
`pom.xml`. A root-level `pom.xml` (single module or aggregator reactor) keeps
precedence in both detection and execution: the nested fallback is skipped and
the run stays rooted at the project root.

- With test files provided, each file is resolved against the project root,
  paths outside the root are dropped, and the file's directory is walked upward
  to the nearest `pom.xml`, bounded at the project root (a pom above the root is
  never used). This enables walk-up detection of a two-level nested pom such as
  `services/backend/pom.xml`.
- With no files, the root's immediate entries are probed one level deep for a
  `pom.xml`: hidden entries (any name starting with `.`) and `node_modules` are
  skipped, the remaining entries are sorted by name, and at most 100 of them are
  inspected, so ties break deterministically to the first match in sorted order.
- A candidate module directory is accepted only when its real (canonical) path
  stays inside the project root's real path, so a symlink or junction that leads
  outside the project is skipped and the search continues with the next
  candidate.

The nested module is detected when `mvn` is on `PATH` or a runnable Maven
wrapper (see below) exists in that module directory. Maven commands then run
from the resolved module directory (`cwd` = module dir) instead of the project
root, so the nested pom is found.

### Repository Maven wrappers now run in preference to `mvn`

Both command-build paths — the default dispatch path (Java backend) and the
legacy switch (`SWARM_LANG_BACKEND=legacy`) — now share one builder and emit the
same command whenever dispatch resolves the directory to the Java backend. (A
directory that holds a `pom.xml` alongside another language's manifest, such as
`package.json`, can resolve to a different backend on the dispatch path; that
backend's default Maven command is still plain `mvn test` with no wrapper.)
When the resolved Maven directory contains a runnable Maven
wrapper, `test_runner` executes that repository-provided script instead of `mvn`
from `PATH`. This also applies to existing **root-level** Maven projects that
ship a wrapper: previously both paths ran plain `mvn test`. `-Dtest=<targets>`
is passed through either way.

- **POSIX:** `./mvnw` runs only when it is a regular file with an execute bit
  set. A wrapper that lost its mode bit (for example from a zip download) is
  skipped and `mvn` is used instead. A `mvnw.cmd` is never used on POSIX.
- **Windows:** only `mvnw.cmd` is used (a POSIX-only `mvnw` is not runnable
  there, so `mvn` is used instead). It is launched through the `cmd.exe` named by
  `%ComSpec%` as `cmd.exe /d /s /v:off /c call "<absolute wrapper path>" ...`,
  the same constrained launcher the `lint` tool uses for `gradlew.bat`. A bare
  `mvnw.cmd` is never spawned: the spawner resolves a bare name against `PATH`,
  not the module directory, so it failed to start. The wrapper is launched only when
  `%ComSpec%` resolves to a real `cmd.exe`, the wrapper's real path stays inside
  the module directory, and neither the wrapper path nor any argument (including
  every `-Dtest` target) contains `"`, `%`, `!`, `^`, `&`, `|`, `<`, `>` or a
  line break, and no argument (such as a `-Dtest` target) ends with a backslash
  (it would escape the launcher's closing quote). Otherwise the run falls back
  to plain `mvn`.

### Known caveats

- **Multi-module reactor:** the nearest `pom.xml` wins. A child module that
  depends on sibling reactor modules may require the aggregator pom; that is out
  of scope.
- **Files in several modules:** when `files` span multiple modules, only the
  module of the first resolvable file is used (`scope: 'all'` with files in
  several modules runs one module).
- **File-less runs need `scope: 'all'`.** `convention`, `graph` and `impact`
  without `files` or `targets` are rejected by the existing guard before any
  detection. `scope: 'all'` with no files uses the one-level nested module probe
  to choose the module directory.
- **Convention scope with Java test files but no targets** keeps the pre-existing
  class-based structured error (`maven does not support targeted test-file
  execution`); deriving `-Dtest` class names from file paths is out of scope.
- **`scope:'target'` native execution remains rooted at the project root** — the
  resolver does not change native target handling.
- **Wrapper fallback needs `mvn`.** Whenever the wrapper is not used (rejected
  token, non-executable `./mvnw`, no `cmd.exe`), the command is plain `mvn`, which
  must then be on `PATH`.
- **Command length:** on Windows the launcher command includes the `cmd.exe` path
  and the absolute wrapper path, and counts toward `test_runner`'s existing
  500-character command limit. This is not a fallback condition: a launcher
  command over the limit returns the existing `Command exceeds maximum allowed
  length` error and does not fall back to `mvn`. Long `-Dtest` lists for Windows
  projects with a wrapper can therefore hit the 500-character limit sooner than
  plain `mvn` would, and the run then errors instead of falling back.
- `test_runner`'s Gradle wrapper (`gradlew.bat`) command on Windows is unchanged
  by this release and still has the bare-name spawn problem the Maven wrapper had
  (tracked in #3040).
- A failed spawn (for example a wrapper that cannot be launched) is still
  reported by `test_runner` as a test regression, because spawn errors are not
  yet classified separately from test failures (pre-existing, tracked in #3039).

Detection remains bounded — no recursive or unbounded scans (AGENTS.md
invariant 1).
