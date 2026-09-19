# Subprocess bounds for the remaining non-#2674 spawn sites (#2705)

`build_check`'s `executeCommand` now passes the full AGENTS.md invariant-3
option set at the spawn site — `stdin: 'ignore'` (previously the wrapper's
silent `mapStdio` default `'pipe'`, the never-closed stdin-pipe class from
v7.3.3), an explicit 5 MiB `maxBuffer`, the existing 300 s timeout and explicit
cwd — and performs a best-effort `proc.kill()` after the output settles. The
platform-shell command form (`/bin/sh -c` on POSIX, `cmd /c` on Windows) is
retained with its justification recorded in-code: build discovery emits shell
command lines by contract (`cmake -B build && cmake --build build`,
`<manager> run <script>`), so naive argv splitting would strip required shell
semantics.

All eight `pkg_audit` runner spawns (npm, pip, cargo, go, dotnet, ruby, dart,
composer) now pass `stdin: 'ignore'`; they were already time-bounded by the
caller-owned `Promise.race` + kill, and the stdin default was the remaining
gap.

`complexity_hotspots` now honors host cancellation: the churn `Promise.race`
gains a third arm on the plugin `ToolContext`'s `abort` signal (threaded
through `execute`/`analyzeHotspots`), so a host-side abort surfaces the tool's
structured error naming the cancellation promptly instead of riding the full
10 s deadline; without a signal the behavior is unchanged.

Optional tightenings from the issue: the `diff` AST helpers
(`git cat-file -e` / `git show`) and the deprecated legacy `deriveProjectHash`
now pass explicit `maxBuffer` bounds (5 MiB matching their siblings; 64 KiB
matching the canonical `getGitRemoteUrl`) instead of the implicit 1 MiB
`execFileSync` default.

`docs/engineering-invariants.md` §3 gained the Bun-on-POSIX `killSignal`
caveat (SIGKILL honored under Node-on-POSIX only; Bun's sync timeout kill
signals SIGTERM — the documented reason the #2674 trap-escalation tests are
Windows-gated) and per-caller contract-table rows for every caller bounded
here.
