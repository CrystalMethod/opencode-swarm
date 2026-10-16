# Declarative SDD provider selection (`SWARM_SDD_SOURCE` and `sdd.source`)

## What changed

When a repository has both OpenSpec (`openspec/`) and Spec-Kit (`.specify/`) sources and no native `.swarm/spec.md`, `readEffectiveSpecSync` reports an ambiguity and returns no effective spec. Resolving it previously required the interactive `--source` flag of `/swarm sdd`, which gates, hooks and other non-interactive consumers cannot pass. The provider can now be selected declaratively:

- **`sdd.source`** in the plugin config (`.opencode/opencode-swarm.json`, or the user config at `~/.config/opencode/opencode-swarm.json`; the project file wins) accepts `openspec`, `speckit` or `swarm`. It is a registered config key, validated by the schema, covered by `/swarm doctor`, and listed in the generated config reference and the shipped JSON Schema.
- **`SWARM_SDD_SOURCE`** (environment variable, case-insensitive) accepts the same values and takes precedence over `sdd.source`.
- Precedence is: a native `.swarm/spec.md` (always wins) → `--source` → `SWARM_SDD_SOURCE` → `sdd.source` → auto-detection. With nothing set, behavior is unchanged.
- `/swarm sdd status`, `validate` and `project` use the same resolution, so the CLI and the drift/preflight gates no longer disagree. `status` reports `Source selection: …` when the provider came from the environment or config.

## Safety behavior

A selected provider is final, exactly like `--source`: if it yields no spec (for example `SWARM_SDD_SOURCE=openspec` in a repo that only has `.specify/`, or `swarm` without a `.swarm/spec.md`), the repo is not silently re-auto-detected. Instead a one-time advisory (visible in `/swarm diagnose`) names the selection and the repository, because a missing effective spec downgrades the drift gate to advisory and skips requirement-coverage preflight. An unrecognized `SWARM_SDD_SOURCE` value is likewise reported once and ignored rather than dropped silently. An invalid `sdd.source` in a config file is a validation error like any other invalid key: the loader reports it (and `/swarm doctor` names `sdd.source`), the loader's fail-secure recovery then applies exactly as it does for every other key (with a user-level config present the project config is discarded until the value is fixed), and the SDD resolver additionally buffers its own advisory and falls through to auto-detect. The resolver reads `sdd.source` directly from the config files (silently; file-level load problems stay with the full loader), so it can still honor `sdd.source` from any project config the loader discarded (another invalid key, or a refused prototype-pollution payload such as `__proto__`) — `sdd.source` is a three-value provider selector, not a security setting.

## Migration

No migration required. Nothing changes unless `SWARM_SDD_SOURCE` or `sdd.source` is set. Because the environment variable is process-wide, prefer `sdd.source` in the project config for per-repository pinning and reserve the variable for CI or one-off overrides.
