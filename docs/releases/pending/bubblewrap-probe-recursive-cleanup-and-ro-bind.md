# Bubblewrap capability probe: fix temp cleanup and the false `fs=weak` verdict

Fixes two defects in the Linux bubblewrap capability probe in `src/sandbox/capability-probe.ts`, which feed `/swarm diagnose` output and the `require_filesystem` sandbox requirement check.

## Changes

- **Temp cleanup no longer fails (and leaks):** the probe removed its temp directory with `fs.rmSync` without `recursive`, which throws `ERR_FS_EISDIR` on Node and `EFAULT` on Bun for any directory. Every probe therefore left a `swarm-bwrap-probe-*` (or `swarm-seatbelt-probe-*` on macOS) directory in the OS temp dir and reported a misleading `probe temp cleanup failed` reason. Cleanup now passes `{ recursive: true, force: true }`, and the default `_internals.removeProbeTempRoot` applies the same flags.
- **Correct filesystem verdict on working bubblewrap hosts:** the probe now binds its temp root read-only (`--ro-bind tempRoot tempRoot`) before the writable `allowedRoot` bind. Previously bubblewrap created the unbound parent in its writable tmpfs root, so the out-of-scope probe write succeeded inside the sandbox and the probe reported `filesystem: weak` on hosts where isolation works. Such hosts now report `filesystem: real`, so `require_filesystem` checks that were wrongly failing on them pass.
- **Tests:** the probe test now pins the `--ro-bind` argument and its order before `--bind`, the cleanup flags, and that the non-empty probe directory is really removed.
