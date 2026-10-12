# SBOM lockfile parsers are truthful against a real-lockfile matrix

## What

`sbom_generate` now emits correct, deduplicated component sets for yarn classic, Yarn Berry, npm v1/v2/v3 (scoped and nested entries), pnpm v5-v9, and NuGet v1 lockfiles. Previously the parsers silently dropped a third or more of real-world lockfile entries while the tool still reported `pass`: yarn classic lost every range-keyed, quoted-scoped, and comma multi-key entry (only exact-pinned unscoped keys parsed); Yarn Berry lockfiles contributed zero components; npm v2/v3 lockfiles emptied scoped names (`@types/node`) and emitted garbage for nested entries (`debug/node_modules/ms`); pnpm v9+ lockfiles contributed zero components (the key grammar required pnpm v5/v6's leading slash); and NuGet v1 `dependencies`-only lockfiles hit a dead fallback arm. The emitted BOM also duplicated manifest-vs-lockfile entries at different versions (`express@4.18.0` alongside the resolved `express@4.18.2`).

Lockfile-resolved entries now take precedence over manifest declared-range entries, exact-purl duplicates collapse, and the tool verdict's fallback branch is honest (`skip` when nothing was processed, matching the declared type). Truthfulness is pinned by a checked-in redacted fixture matrix (`tests/unit/sbom/fixtures/lockfiles/`) whose tests assert exact `name@version` set equality per format — any parser that drops or double-counts a component class now fails the suite instead of passing silently.

## Why

Frontier-audit findings `MICRO-t1-src-sbom-1-1` and `MICRO-t1-src-sbom-1-2` (both HIGH, dual-arm executed against shipped source and real lockfiles): the parsers are the product output of a default-on gate tool and were silently wrong for the second-largest JS package manager's default lockfile shapes, guarded by a 57-test suite whose own fixtures contained the dropped shapes without asserting them (issue #2956, Workstream J PR slot 10).
