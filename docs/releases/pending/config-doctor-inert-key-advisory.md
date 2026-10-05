# `/swarm config doctor` names set-but-unconsumed config keys by name (issue #2957)

## What changed

`/swarm config doctor` reports an `inert-config-key` warning (severity warn)
when a config file you wrote sets a top-level key that no runtime consumer
reads — naming the key, the reason it does nothing, and the replacement when
one exists. The advisory reads the raw config files (`~/.config/opencode/
opencode-swarm.json` and `.opencode/opencode-swarm.json`), so it fires only
for keys you explicitly set, never for schema defaults. The inert/consumed
declaration behind it lives in `src/config/consumers.ts` (`CONFIG_CONSUMERS`)
and is enforced by the config-consumption ratchet (#2904); today the one
declared-inert key is `parallelization`.

With the #3065 wiring (issue #2949) the two keys this issue was authored
around — `harness_opt` and `skill_opt` — are consumed plugin-config keys, so
doctor correctly stays silent when you set them: the blocks take effect.

This change pins both declaration arms so the advisory cannot silently
regress: `collectRawInertKeyFindings` is now exported with a
default-parameter DI seam (mirroring the gate-satisfiability collector), and
`tests/unit/services/config-doctor-inert-keys.test.ts` proves both shapes on
any tree — the production map stays silent on consumed keys while the
`parallelization` control keeps warning, and injected inert declarations
produce the advisory with the full reason rendered. A hand-written section
in `docs/configuration.md` documents the advisory.
