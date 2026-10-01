## test_runner detects and runs nested Maven modules

`test_runner` failed to detect Maven at all when the project root did not itself
contain a `pom.xml` and the Maven module lived in a nested directory (for
example `backend/pom.xml`). Root-level framework detection found nothing, so the
run fell through to no framework and the nested module was never exercised.

A new exported resolver, `resolveMavenModuleDir(root, files?)`, now backs a
last-resort nested fallback that runs **only after every existing root-level
detector returns no match** (root-level precedence is unchanged):

- With test files provided, each file is resolved against the project root,
  paths outside the root are dropped, and the directory is walked upward to the
  nearest `pom.xml`, bounded at the project root (a pom above the root is never
  used). This enables walk-up detection of a two-level nested pom such as
  `services/backend/pom.xml`.
- With no files, the immediate subdirectories are probed one level deep —
  skipping `node_modules` and `.git`, capped, and iterated in sorted
  directory-name order so ties break deterministically to the first match.

Maven commands now run from the resolved module directory (`cwd` = module dir)
instead of the project root, so `mvn test` finds the nested pom.

### Maven wrapper is now preferred on both command-build paths

The default dispatch path (`buildTestCommandViaDispatch` → Java backend) always
used `mvn` even when a wrapper existed. A `buildTestCommand` override in the Java
backend now prefers the Maven wrapper exactly like framework selection does:
`./mvnw` (`mvnw.cmd` on Windows) when present in the module directory, otherwise
`mvn` from `PATH`, with `-Dtest=<targets>` support. The legacy switch
(`SWARM_LANG_BACKEND=legacy`) Maven case was brought to parity.

### Known caveats

- **Multi-module reactor:** the nearest `pom.xml` wins. A child module that
  depends on sibling reactor modules may require the aggregator pom; that is out
  of scope.
- **`scope:'target'` native execution remains rooted at the project root** — the
  resolver does not change native target handling.
- **Convention scope with Java test files but no targets** keeps the pre-existing
  class-based structured error (`maven does not support targeted test-file
  execution`); deriving `-Dtest` class names from file paths is out of scope. The
  file-less convention scenario (the reported bug) runs `mvn test` in the
  resolved module directory.

Detection remains bounded — no recursive or unbounded scans (AGENTS.md
invariant 1).
