# PR-review consolidated micro prompt ordering

## What changed

PR-review base and micro lanes with explicit `owned_workflow_lanes` now apply the controller-owned explorer output contract before the PR workflow contract. Operator-authored `[CANDIDATE]` markers remain rejected with the existing diagnostic.

## Why

The PR workflow contract names the owned obligations using controller-generated `[CANDIDATE]` and `[CLEAN]` markers. Applying the explorer validator afterward incorrectly classified those controller markers as operator prompt content and blocked valid consolidated micro dispatches.

## Migration steps

None.

## Breaking changes

None.

## Known caveats

Ordinary `workflow_lane`-only lanes retain the existing contract-first ordering.
