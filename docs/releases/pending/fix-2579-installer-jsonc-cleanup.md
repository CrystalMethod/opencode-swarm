# Installer JSONC and cleanup fixes

## What

- Preserve quoted strings containing comma/brace, comma/bracket, escape, and
  comment-marker text while normalizing JSONC configuration.
- Make uninstall --clean remove only the existing safety-checked
  plugin-owned files even when the host configuration is missing, malformed, or
  otherwise a no-op.

## Why

The installer previously applied trailing-comma removal across quoted values,
and cleanup was unreachable after several valid host-configuration early
returns. Both paths now remain fail-closed and idempotent.

## Migration

No migration is required. Ordinary uninstall behavior and host configuration
mutation remain unchanged; --clean is still the explicit authorization for
removing plugin-owned configuration, prompts, and install-backup files.
