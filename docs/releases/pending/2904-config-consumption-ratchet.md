---
issue: 2904
---

### What changed

- Added `src/config/consumers.ts` — `CONFIG_CONSUMERS`, a `Record<TopLevelConfigKey, …>` declaring for every top-level `PluginConfigSchema` key either the production code that consumes it (`path:symbol` citations) or an `inert` marker with a reason. Adding a schema key without an entry now fails `bun run typecheck` (compile-time exhaustiveness).
- Added `scripts/check-config-consumption.ts` and wired it into the CI quality job as a direct-invocation step (`bun run scripts/check-config-consumption.ts`; `package.json` is release-owner-guarded by #2677 and is not touched). The gate verifies every citation: canonicalized (incl. `..`/case-alias) path rules, non-test `src/**` only, schema-definition files are not consumers, DI/test seams are not consumers, a citation into `config-doctor.ts` never satisfies the ratchet alone (that file references every key), and the cited symbol must actually reference the key in code (member/bracket/destructure/case forms under comment-stripped, string-masked matching). `CONFIG_CONSUMPTION_ENFORCE=0` soft-warns.
- `/swarm config doctor` now emits an `inert-config-key` warning (severity warn) when a user's raw config file sets a key declared inert — driven by the raw files so schema defaults never produce noise. Baseline: `parallelization` (dark PR-1 foundation; setting it has no runtime effect) is the one inert key; the advisory names the reason and the replacement (plan `execution_profile`).
- `docs/configuration.md`'s generated top-level table gained a "Consumed by" column — emitted by the generator inside the marker block from the same declaration, so it cannot drift; inert keys render `(inert)`.

### Why

Config keys could be added with a doctor case, regenerated schema/docs, and zero runtime consumers — the class behind #2, #2524 (whole `gates.*` section inert), #2580 (`plan_cursor` effective on one path only), and #2583. Every prior fix was one key at a time; this installs the class-level ratchet the frontier audit recommended (audit E3; closes the #2904 required scope).

### Notes

- Boundary disclosure: the ratchet covers TOP-LEVEL keys; per-sub-field consumption inside sub-schemas is not ratcheted by this change. A one-time scan of all 66 sub-schema `.describe()` strings found zero unfulfilled runtime-effect promises (3 flagged by heuristic, all verified consumed — e.g. `council.vetoPriority` at `council-service.ts:47,315`).
- AC3 route disclosure: the advisory is emitted by a raw-file collector inside `runConfigDoctor` (not literally inside `validateConfigKey`) so it fires only on user-written keys.
- Accepted imprecision (pinned by tests): object-literal label maps (`{ key: 'label' }`) are textually indistinguishable from destructure renames and count as references.
- New tests: `tests/unit/scripts/check-config-consumption.test.ts` (matcher + fixture suites), `tests/unit/config/consumers-exhaustiveness.test.ts`, `tests/unit/services/config-doctor-inert-key-2904.test.ts`, `tests/unit/scripts/generate-config-schema-consumed-by.test.ts`.
