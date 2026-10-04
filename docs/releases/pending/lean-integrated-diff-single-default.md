# Lean Turbo: integrated_diff_required has one default — DEFAULT_LEAN_TURBO_CONFIG (true)

## What changed

`turbo.lean.integrated_diff_required` now has exactly one default: `true`, from `DEFAULT_LEAN_TURBO_CONFIG` (`src/config/constants.ts`), everywhere. Previously the phase-readiness check in `src/turbo/lean/phase-ready.ts` carried a module-local `false` default, so on the no-config Lean Turbo path (the shipped default for lean users — the `/swarm turbo lean` toggle is session-state only and never persists `turbo.lean`) the integrated-diff evidence check was silently skipped before phase advance, while the lean reviewer tool on the same run already required the diff summary. The two gates disagreed within one run.

After this change, a lean phase without explicit config requires the integrated-diff evidence artifact (`.swarm/evidence/<phase>/lean-turbo/lean-turbo-phase.json`, written by every standard lean phase run) before it can advance — phase readiness now agrees with what the Zod schema default, the config-doctor gate-satisfiability lint, the lean reviewer tool, and the runner config merge already enforced.

## Opting out

Set `turbo.lean.integrated_diff_required: false` in your project's `.opencode/opencode-swarm.json` to restore the old permissive behavior. Only the default changed; explicit configuration was and remains honored.

## Fail-closed caveat

If the phase-evidence write fails or the runner dies between lane completion and the evidence write, the phase cannot advance until the evidence artifact exists or the option is explicitly set to `false`. This is intentional fail-closed behavior: the gate now surfaces a missing integration summary instead of silently skipping it. Recovery depends on where the run stopped: if the phase is mid-flight (tasks still incomplete), re-running the phase's evidence-producing step writes the artifact and unblocks advancement; if the run died after the final task completed, that step short-circuits (a completed phase produces no new lane plan), and the remedies are the explicit `turbo.lean.integrated_diff_required: false` opt-out or recreating the evidence artifact. The runner now emits an always-visible warning when a phase-evidence write fails, and the `LEAN_TURBO_PHASE_NOT_READY` block carries a recovery hint naming the option and the artifact path.

## Verification

- Defaults pin test asserts schema-default == constants-default == phase-ready-local-default for all three lean gate keys (leaf schema and full-plugin union parse), so a future default split fails CI. The pin test imports the exported, frozen `DEFAULT_CONFIG` — a source-only revert of the projection fails at module load by design (canary).
- Behavioral tests pin the flipped no-config path (not-ready without diff evidence, ready with it), the preserved explicit opt-out at the gate, and the explicit-undefined fail-closed fallback.
- A config-file journey test drives `turbo.lean.integrated_diff_required: false` through the production `phase_complete` mapping and proves the gate skips check 7 under the opt-out (critic reason surfaces instead of the integrated-diff reason), plus a control arm proving the default blocks check 7 end-to-end.
- The full lean phase-readiness, phase-complete reviewer/critic, and runner suites stay green.
