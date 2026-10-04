# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for a security vulnerability.

Report it privately through GitHub's coordinated disclosure flow:

1. Go to <https://github.com/ZaxbyHub/opencode-swarm/security/advisories/new>
2. Choose the affected version and severity, and describe the issue.

If that form is unavailable to you (for example it asks you to sign in and you
do not have an account), open a regular issue titled `security report` with no
reproduction details and a note that a private channel is needed — we will move
it off the public board. Do not post exploit details in the public issue.

We aim to acknowledge reports within a few days. If a report is accepted, we
will agree a disclosure timeline with you and credit you in the advisory unless
you prefer to stay anonymous.

## What counts as a vulnerability in this project

opencode-swarm is a plugin that runs inside another agent host, so it holds a
position of unusual trust: it reads and writes files in your project, spawns
subprocesses, and makes model-driven decisions about what may be changed. Treat
these as security-relevant:

- **Write-scope escape.** Bypassing the declared working-directory scope, the
  temp-file quarantine decision in `src/services/swarm-residue.ts` (a grammar's
  `readonly quarantineEligible` flag in `src/utils/atomic-write.ts`, plus the
  staleness, git-tracked, symlink, active-lock, oversize, and target-absent
  checks that must also pass), or a guardrail that is supposed to block a write
  (see `src/hooks/guardrails/tool-before.ts` and
  `src/hooks/shell-write-detect.ts`).
- **Command execution.** Any path where a shell command, argument, or
  environment value reaches a subprocess without the documented sanitization,
  or where a guardrail meant to block a destructive command fails open. The
  shared spawn wrappers are in `src/utils/` (`bun-compat.ts`,
  `external-tool-runner.ts`, `gh-executable.ts`, `git-executable.ts`,
  `glab-executable.ts`, `windows-batch.ts`), but dozens of other non-test
  files under `src/` — `src/git/`, `src/tools/`, `src/hooks/`, `src/commands/`
  and more — reach `node:child_process` directly, so treat the wrapper layer
  as one entry point rather than the boundary. The highest-value surface is
  the sandbox executor family — `src/sandbox/linux/bubblewrap-executor.ts`,
  `src/sandbox/macos/sandbox-exec-executor.ts`,
  `src/sandbox/win32/restricted-environment-executor.ts`,
  `src/sandbox/win32/runner-client.ts` — plus `src/hooks/spawn-helper.ts`.
  Guardrails live in `src/hooks/guardrails/`.
- **Secret exposure.** Leaking a credential from the environment, from project
  configuration, or from `.swarm/` runtime state into a transcript, log, issue,
  or PR body. Redaction on those egress paths is defined in
  `src/memory/redaction.ts` (`redactSecrets`) and
  `src/hooks/guardrails/helpers.ts` (`redactShellCommand`, used by the
  guardrail audit log). The opt-in in-session secret scanner, which runs as a
  pre-check gate rather than a git hook, is separate: `src/tools/secretscan.ts`.
- **Untrusted input.** A weakness in the external-skill or external-content
  ingestion path that allows prompt injection, unsafe instructions, or a
  provenance bypass to be promoted past its validation gate. The gates are in
  `src/services/external-skill-validator.ts` and
  `src/services/external-content-scanner.ts`, with the curation tools in
  `src/tools/external-skill-*.ts`.
- **Plugin load-path compromise.** A way to get attacker-controlled code to run
  during plugin initialization or install (see `src/index.ts` and `src/cli/`).

## Out of scope

- Findings that require an attacker who already has write access to *this*
  repository (ZaxbyHub/opencode-swarm) or to the user's machine. Note that
  attacker-controlled **project content** — a malicious repository, issue, or
  file the agent reads while working — is not out of scope; steering the agent
  into a write-scope escape or a credential leak through project content is
  exactly the class we want to hear about.
- Issues in third-party dependencies with no reachable path through this
  project's own code. Please report those upstream as well, but let us know so
  we can record the reachability assessment.
- Denial of service requiring an already-compromised host.
- Anything the built-in guardrails surface as an advisory or a user-configurable
  setting with its safe default in place.

## Supported versions

Fixes land on the latest release line. Because the plugin is installed from npm
or by the `opencode-swarm install` CLI, upgrade with:

```bash
bunx opencode-swarm update     # cache-only refresh, then restart OpenCode
bunx opencode-swarm install    # full reinstall, re-asserts config
```

Older versions are not patched. If you cannot upgrade promptly, tell us in the
report and we will prioritize accordingly.
