/**
 * Bun test preload (PR #3328 closeout): neutralize the ambient
 * `SWARM_SDD_SOURCE` environment variable before ANY test file loads.
 *
 * Registered in bunfig.toml under [test] preload, alongside
 * `executable-resolver-pin.ts`. Why this exists: `readEffectiveSpecSync` now
 * honors `SWARM_SDD_SOURCE` (declarative SDD provider selection), so a
 * developer shell that exports it silently changes the outcome of every
 * suite that resolves an effective spec WITHOUT passing `opts.source`
 * (src/sdd/effective-spec.test.ts, tests/unit/commands/sdd*.test.ts,
 * issue-2501 multi-feature, diagnose-buffered-warning, ...). Several of those
 * files are grandfathered over the FR-006 500-line cap and may only shrink, so
 * a per-file `beforeEach` env pin is not possible there; a single preload fixes
 * all of them at once (the same reasoning as executable-resolver-pin.ts).
 *
 * Tests that exercise the variable set it themselves and restore it in
 * `afterEach`; deleting it here only removes the AMBIENT value. The user-level
 * config trigger (`sdd.source` in ~/.config/opencode/opencode-swarm.json) is a
 * host-dependent property of every config-reading suite and is handled per
 * suite via XDG_CONFIG_HOME, as for the other user-config-sensitive suites.
 */
delete process.env.SWARM_SDD_SOURCE;
