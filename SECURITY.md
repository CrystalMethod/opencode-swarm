# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for a security vulnerability.

Report it privately through GitHub's coordinated disclosure flow:

1. Go to <https://github.com/ZaxbyHub/opencode-swarm/security/advisories/new>
2. Choose the affected version and severity, and describe the issue.

You should receive an acknowledgement within a few days. If a report is
accepted, we will agree a disclosure timeline with you and credit you in the
advisory unless you prefer to stay anonymous.

## What counts as a vulnerability in this project

opencode-swarm is a plugin that runs inside another agent host, so it holds a
position of unusual trust: it reads and writes files in your project, spawns
subprocesses, and makes model-driven decisions about what may be changed. Treat
these as security-relevant:

- **Write-scope escape.** Bypassing the declared working-directory scope, the
  temp-file quarantine that `src/utils/atomic-write.ts` gates on its
  `readonly token: 'instance' | 'constant'` discriminator, or a guardrail that
  is supposed to block a write (see `src/hooks/guardrails/tool-before.ts` and
  `src/hooks/shell-write-detect.ts`).
- **Command execution.** Any path where a shell command, argument, or
  environment value reaches a subprocess without the documented sanitization,
  or where a guardrail meant to block a destructive command fails open.
- **Secret exposure.** Leaking a credential from the environment, from project
  configuration, or from `.swarm/` runtime state into a transcript, log, issue,
  or PR body. Redaction on those egress paths lives in `src/memory/redaction.ts`
  (`redactSecrets`) and `src/hooks/guardrails/audit-log.ts`; the pre-commit
  secret scanner is separate, in `src/tools/secretscan.ts`.
- **Untrusted input.** A weakness in the external-skill or external-content
  ingestion path that allows prompt injection, unsafe instructions, or a
  provenance bypass to be promoted past its validation gate. The gates are in
  `src/services/external-skill-validator.ts` and
  `src/services/external-content-scanner.ts`, with the curation tools in
  `src/tools/external-skill-*.ts`.
- **Plugin load-path compromise.** A way to get attacker-controlled code to run
  during plugin initialization or install (see `src/index.ts` and `src/cli/`).

## Out of scope

- Findings that require an attacker who already has write access to the
  repository or to the user's machine.
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
