# Epic Mode (preview): outcome-based self-calibration

## What changed

- Epic Mode ships Capability D — **outcome-based self-calibration**. When `epic_next_wave` closes a wave (see `epic-mode-v2.md`), every completed task whose actual files are known gets one record in `.swarm/epic/divergence.jsonl` comparing its declared scope (frozen into the wave) with the files it wrote. The calibration engine then consumes the new records and updates `.swarm/epic/calibration.json`:
  - `hotModuleAdditions` — files written without being declared are added permanently (**monotonically grows**; removal is manual). `epic_next_wave` runs a task whose scope touches one of them alone.
  - `activationThresholdOverride` — tightens by `tighten_step` per divergent task (never below `floor_threshold`) and loosens toward the static `turbo.epic.mode.activation_threshold` only after `loosen_window` consecutive clean tasks. Shown by `/swarm epic calibration`.
- New modules in `src/turbo/epic/`: `divergence-recorder.ts` (pure `computeDivergence` + capped append-only JSONL writer), `calibration.ts` (atomic, fail-closed state file), `calibration-engine.ts` (pure `applyCalibration`, `effectiveHotModules`).
- New optional `turbo.epic.calibration.*` config block: `enabled: true`, `floor_threshold: 0.05`, `tighten_step: 0.02`, `loosen_step: 0.01`, `loosen_window: 10`.

## Why

Each task's outcome (declared scope vs. actual writes) feeds back into how later waves are composed: a file that is repeatedly written without being declared becomes a hot module, so tasks touching it stop running concurrently with others.

## Migration steps

None. With `turbo.epic.mode.enabled` left at its default (`false`), no calibration code runs and no calibration files are written. Set `turbo.epic.calibration.enabled: false` to record divergence without learning hot modules.

## Known caveats

- Divergence is recorded only for tasks whose actual files are known (coder write attribution, or the git fallback for a single-task wave); calibration never learns "clean" from absent data.
- Defaults are reasoned estimates, not measured optima.
- The hot-module list is append-only by design; removing a false positive requires editing `.swarm/epic/calibration.json` by hand.
