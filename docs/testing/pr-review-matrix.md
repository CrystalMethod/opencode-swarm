# PR-review completion qualification matrix (issue #2586)

This document is the evidence matrix for the final compatibility/feature
qualification gate of the PR-review completion pipeline (issue #2586,
Workstream H, slot 9). It consumes #2585's default-path proof and extends it
across the claimed support matrix. Every required cell below carries either an
`evidence:` pointer (a fixture, suite, script, or recorded live run — with its
execution surface named) or a `decision:` disposition (an explicit product
support decision, never an interpolation). Strict single-system provider cells
are DELEGATED to #2673 and are intentionally absent here.

Toolchain at qualification: bun 1.3.14 local (Windows 11, win32 x64), node for
the canary legs, repo floors Bun >=1.3.13 / Node >=22.13 (package.json). The
closing source revision is the PR head; live-run records pin it explicitly
(`implementation_revision` + plugin build digest, enforced by the
publish-time freshness gate and the run verifier). macOS/Linux cells are
claimed only through the pull-request per-file unit CI matrix on
ubuntu/macos/windows (the #2666-established pattern) — never extrapolated from
the local Windows leg.

## Matrix cells

| cell | disposition |
|---|---|
| R01 | evidence: depth/re-tier re-anchor at base 374c2642e — the #2585 fixtures r01-entry-binding, r03-clean, r04-nonempty, r05-critic-projection, r06-08-verdict-coverage-policy all PASS (17/17 file loop, frozen check C1); tier floors + unclassified-risk MUST-MATCH + resilience-default enforcement suites PASS (6/6, frozen check C2: pr-review-trigger-contract, dispatch-lanes-pr-review-micro-cycle, pr-workflow-response-gate-ceiling-derivation, write-pr-review-trigger-eval-provenance, pr-workflow-gate-resilience-default, schema-pr-review-resilience). No count inflation: the exact-coverage boundary gate is exercised inside r03/r04. DD-C019 (partial-admission rollback) is closed by the frozen check C2 executing tests/unit/tools/write-pr-review-artifact-partial-base-coverage-adversarial.test.ts at the closing revision (8 tests, 23 expects, GREEN at base and head). |
| R09 | evidence: NEW fixture tests/unit/pr-review/r09-resilience-off-on-2586.test.ts (3 tests): off leg completes the legacy one-wave journey; on leg completes the staged canary-first + fanout journey (the one-wave shape is refused pre-launch with zero child prompts) and preserves per-run identity across a simulated process restart (workflowInstanceId/revision/prHeadSha + staged-batch receipts durable); retry leg proves only the terminally-failed lane is re-dispatched (a NEW partial-retry batch id — base batch ids are append-only by design) while the five successful lanes' durable records stay byte-identical. |
| R10 | evidence: composed-failure budgets frozen and measured — tests/unit/tools/dispatch-protection-budget-manifest.ts (two effective configurations with integer + wall-clock ceilings) and tests/unit/tools/dispatch-protection-2507.test.ts (worst composed sequences driven through the real booted plugin, asserted against BOTH bounds; frozen check C4, 2/2 PASS). Distinct failure owners: spawn-circuit denials exempted from the policy gate_denial streak owner (#2507), the six composed classes surface as distinct typed classes in the r14/r09/r10 legs. NEW real-fs pin: tests/unit/pr-review/r10-live-reblock-realfs-2586.test.ts (3 tests, no digest/clean/head mocks — see R11-R18 note on layering). |
| R11 | evidence: r11-denial-status-repair.test.ts PASS at base (re-anchor, frozen check C1) — operator status + ordinary denial repair retain the base contract. |
| R12 | evidence: r12-abort-recovery-registered.test.ts PASS at base (re-anchor, frozen check C1) — recovery abort with restoration receipts and wake stop. |
| R13 | evidence: r13-resume-compaction.test.ts PASS at base (re-anchor, frozen check C1) plus the r09 restart leg (durable identity after in-process restart). Disclosed boundary: restart is simulated in-process (the #2585/#2666 disclosed limitation); the live runs below exercise a real host process. |
| R14 | evidence: r14-evidence-read-repair-registered.test.ts PASS at base (re-anchor, frozen check C1) — controlled evidence-read failure with frozen limits. |
| R15 | evidence: r15-freshness-rebind.test.ts PASS at base (re-anchor, frozen check C1) — rebind refused naming both SHAs; sanctioned path works. |
| R16 | evidence: r16-user-checkout-registered.test.ts PASS at base (re-anchor, frozen check C1) — checkout stash/restore through the registered path with the gate-clear-is-not-restoration negative. |
| R17 | evidence: r17-finalization-concurrency.test.ts PASS at base (re-anchor, frozen check C1) — clear-once, no live lanes, cross-session refusals. |
| R18 | evidence: r18-handoff-registered.test.ts PASS at base (re-anchor, frozen check C1) — exact actionable handoff set, DISPROVED excluded. |
| R19 | decision: optional council cell not claimed. Council is off by default (src/config/schema.ts CouncilConfigSchema enabled:false) and the issue gates the cell on "only when the council feature is enabled AND a real PR-council caller consumes the general parser". Caller census recorded as a raw artifact (the qualification trace file repro/census/council-caller-census.txt holds the grep transcripts proving the single production import surface), taken 2026-09-19 at the qualification head: the #2578 general parser `extractLeadingStanceDeclarations` has exactly one production consumer path — src/tools/convene-general-council.ts -> src/council/general-council-service.ts:72/:274; the PR-review council lanes (evaluation-fixtures SKILL "Council Mode Workflow") dispatch through the lane machinery and do not consume the general parser, so the conditional trigger is not met for this matrix. #2578 is closed; #2491 integration evidence stands on its own issue. |
| R20 | evidence: runtime floor — Bun x Windows executed locally (all fixtures above, per-file, counts as recorded). Bun x macOS/Linux: decision: NOT YET EVIDENCED at trace closure — no CI run for this branch existed when this document was committed; the cells will be evidenced by this PR own per-file unit CI matrix on the pushed head (run URLs attached to the PR body when they exist), and until those runs complete these cells carry NO qualification claim (the #2666 execute-journey evidence is not inherited). Node-context legs: scripts/canary-pr-review-journey.mjs --deterministic imports the built bundle under Node and asserts the v1 plugin shape plus all eight PR-review controller tools in server() output (verified with both a pre-built dist and a fresh bounded build). Ungated invocation exits 3 with a typed refusal; gated without a reachable server exits 4 typed. LABELED UNEXECUTED (no claim): the full PR-review journey under Node (requires a live controller host session; the canary's live leg is deliberately not implemented in this matrix — exit 5 refuses to fabricate model-backed evidence), Node on macOS/Linux, and any model-backed canary leg. One platform's fixture does not certify another; each OS cell is claimed only by its own matrix leg. |
| live-provider | evidence: the three #2585 live cases rerun at the closing revision as installed-package journeys through the real OpenCode host (frozen cases + run records + artifact digests under the #2586 issue trace; verifier verify-live-runs-2586.mjs must report ALL CHECKS PASSED, host pin recorded in live-runs-2586/host-declaration.json). Carry-forward decision: NONE — all cases rerun (owning-path drift since the 84f023f09 runs invalidates each; the recorded comparison documents why). Historical 84f023f09 records remain as prior evidence only. |
| procedural | evidence: NEW fixture tests/unit/pr-review/procedural-host-boundary-2586.test.ts (4 tests): the documented executable fallback is real — a Profile-B-shaped lane artifact parses through the production candidate parser (parseAndPersist via parse_lane_candidates) with full lane/severity mapping and durable sidecar persistence; [CLEAN] attestations parse; malformed pipe-broken rows are bounded diagnostics, not crashes; the no-client and pre-activation controller-tool refusals are typed, bounded, non-hanging. DISCLOSED GAP (pinned, not edited): neither refusal text names the row-convention fallback or Profile B — the only production pointer to the convention is the parser's format_mismatch_hint (src/background/candidate-parser.ts:416-432); operator guidance lives in the SKILL text. No production profile-detection helper exists (A/B/C classification is SKILL-text-only) — recorded here rather than tested. |
| multi-swarm | evidence: NEW fixture tests/unit/pr-review/multiswarm-preflight-consumption-2586.test.ts (5 tests) consuming #2680's contract without recreating it: two enabled swarms (prefixed lane agents registered as subagents); resolved selections proceed; unresolved selections deny with SWARM_AGENT_MODEL_UNRESOLVED (and PLAN_CRITIC_MODEL_UNRESOLVED for the critic lane); catalog-unavailable fails open; missing per-swarm selection denies with SWARM_AGENT_MODEL_MISSING_SELECTION while the sibling swarm proceeds. Surface disclosure: the delegation-gate Task-dispatch preflight (src/hooks/delegation-gate.ts:4169/:4236 calling src/services/model-preflight.ts checkSingleModelResolution) is where PR-review lane-agent model admission is consumed — dispatch_lanes_async children ride host session.create and do not pass tool.execute.before. |
| v2-beta | decision: not claimed. No v2-beta host/channel claim exists in this repo's supported-matrix documentation (docs/engineering-invariants.md:16-19 lists the claimed contexts); per the issue, v2 beta requires an explicit support/canary decision before any qualification claim, and none is made here. |
| plugin-binding | evidence: every cell above names its binding — the deterministic fixtures are source/instrumented runs (bun test booting the real plugin from this worktree); the live-provider cells are installed-package journeys (global opencode plugin entry resolving opencode-swarm, recorded per run with the plugin build digest); the Node canary is a built-bundle run (dist import). Unbound or instrumented controls are never mixed into installed-package claims. |
| cache-version | evidence: discipline enforced — no cell cites a package-cache version as proof of what a historical run loaded. Live-run identity binds to entry.plugin_build_sha256 (recomputed digest of the loaded build) plus implementation_revision and the host-declaration, per verify-live-runs-2586.mjs; the plugin cache is restored to the published build after the runs (AGENTS.md invariant 12). |
| additional-provider | decision: no additional provider is claimed by this matrix. The three live cases run the #2585-declared model (zai-coding-plan/glm-5.2, no silent substitution — provider unavailability on run day blocks the live cells honestly). A future additional provider requires its own frozen case and a verifier generalization away from the declared-model fragment before any claim. |
| installed-stale-skill | decision: conditional #2601 cell not claimed. The issue lists #2601 as a conditional prerequisite "only when installed stale-skill qualification is claimed"; no such claim is made by this matrix (the live runs use freshly synced skills, recorded per run). |

## Delegation boundary

Strict single-system provider behavior is DELEGATED to #2673 (capability
qualification, PR #2750): those cells are deliberately absent from this matrix
and must not be reported here, per the issue body. No strict-provider cell row
exists above.

## Consumers

- #2504 must consume this evidence before any relevant default/support claim
  changes (governed defaults frame).
- #2502 consumes the qualified review path before claiming an autonomous
  feedback loop.
- #2503 consumes completion/compatibility results for quality comparisons;
  completing this matrix alone is not a state-of-the-art result.

## Verdict vocabulary and failure gate

A cell result is successful completion, truthful INCOMPLETE, explicit
cancellation, or actionable external-repair state, as expected by the fixture.
Endless wake/deny loops, fabricated coverage, lost user checkouts, or
cross-run clearing fail the gate. The layered post-settle blocking stack is
pinned real-filesystem by r10-live-reblock-realfs-2586.test.ts: a dirty tree
(tracked or untracked) refuses at the clean-checkout gate, a committed move
refuses at the exact-head gate, and the inner revision-digest re-LIVE corner
remains mock-covered defense in depth (no real sequencing reaches it with a
clean tree at the settled head — the digest hashes the base plus changed
paths/content, which is constant under those conditions).
