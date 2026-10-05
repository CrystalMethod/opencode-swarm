/**
 * Safe launch of a Windows batch wrapper (`.cmd` / `.bat`) through a
 * validated `cmd.exe`.
 *
 * Node cannot spawn a batch file directly at all: since the CVE-2024-27980
 * hardening `child_process.spawn` rejects a `.cmd`/`.bat` target with EINVAL
 * (measured on Node v24.16.0 for the absolute, cwd-relative and bare-name
 * forms alike). Bun is more permissive — it routes batch files through cmd.exe
 * itself — but that tolerance is a runtime accident rather than a contract, so
 * a launcher must not depend on which runtime hosts the plugin. For the same
 * reason a bare wrapper name such as `mvnw.cmd` is resolved against PATH only,
 * never against the spawn `cwd`. The supported shape is
 * `[<cmd.exe>, '/d', '/s', '/v:off', '/c', 'call "<abs>" "<arg>" ...']`
 * spawned with `windowsVerbatimArguments: true`, so the pre-quoted tail reaches
 * cmd.exe unmodified (the same pattern `src/tools/lint.ts` and
 * `src/tools/pkg-audit.ts` use).
 *
 * Every token (the canonical wrapper path and each argument) is rejected when
 * it contains a cmd.exe metacharacter instead of being escaped, so a caller
 * never builds a command line cmd.exe could re-interpret. Callers must treat a
 * `null` result as "do not launch the wrapper" and fall back to a non-batch
 * command.
 *
 * Extracted from `src/tools/lint.ts` without behaviour change. The functions
 * take their filesystem/environment dependencies explicitly so each caller
 * keeps its own DI seam: lint passes thunks over `lint._internals`, while
 * other callers use this module's `_internals` (the default).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const WINDOWS_BATCH_WRAPPER_EXTENSIONS = ['.cmd', '.bat'] as const;
// Node quotes array-form cmd.exe tokens, keeping spaces and parentheses opaque.
// Reject shell separators, quoting, expansion markers, and line breaks instead
// of attempting to escape them into an executable command string.
const WINDOWS_CMD_UNSAFE_TOKEN = /["%!^&|<>\r\n]/;

/** Filesystem/environment dependencies of the batch-launch helpers. */
export interface WindowsBatchDeps {
	platform: () => NodeJS.Platform;
	comSpec: () => string | undefined;
	realpathSync: (candidate: string) => string;
	statSync: (candidate: string) => { isFile(): boolean };
}

function isRegularFile(candidate: string, deps: WindowsBatchDeps): boolean {
	try {
		return deps.statSync(candidate).isFile();
	} catch {
		return false;
	}
}

/**
 * Resolve the canonical `cmd.exe` from `ComSpec`, or null when it is not an
 * absolute path to a regular file whose canonical basename is `cmd.exe`.
 */
function resolveWindowsCommandInterpreter(
	deps: WindowsBatchDeps,
): string | null {
	const candidate = deps.comSpec();
	if (
		!candidate ||
		!path.isAbsolute(candidate) ||
		path.basename(candidate).toLowerCase() !== 'cmd.exe' ||
		!isRegularFile(candidate, deps)
	) {
		return null;
	}
	try {
		const canonical = deps.realpathSync(candidate);
		return path.basename(canonical).toLowerCase() === 'cmd.exe'
			? canonical
			: null;
	} catch {
		return null;
	}
}

/**
 * Build the constrained `cmd.exe /d /s /v:off /c call "<wrapper>" "<arg>"...`
 * argv for an already-located batch wrapper, or null when the interpreter
 * cannot be resolved, the wrapper is not a regular `.cmd`/`.bat` file, or any
 * token contains a cmd.exe metacharacter.
 */
export function buildWindowsBatchCommand(
	wrapperPath: string,
	args: string[],
	deps: WindowsBatchDeps = _internals,
): string[] | null {
	const interpreter = resolveWindowsCommandInterpreter(deps);
	if (!interpreter) return null;

	let canonicalWrapper: string;
	try {
		canonicalWrapper = deps.realpathSync(wrapperPath);
	} catch {
		return null;
	}
	if (
		!isRegularFile(canonicalWrapper, deps) ||
		!WINDOWS_BATCH_WRAPPER_EXTENSIONS.includes(
			path.extname(canonicalWrapper).toLowerCase() as '.cmd' | '.bat',
		)
	) {
		return null;
	}

	const tokens = [canonicalWrapper, ...args];
	if (tokens.some((token) => WINDOWS_CMD_UNSAFE_TOKEN.test(token))) return null;
	const command = `call ${tokens.map((token) => `"${token}"`).join(' ')}`;
	return [interpreter, '/d', '/s', '/v:off', '/c', command];
}

/**
 * Build the launcher argv for `<cwd>/<fileName>` only on win32, and only when
 * the wrapper's canonical path stays inside the canonical `cwd` (a symlink or
 * junction that escapes `cwd` is rejected). Returns null otherwise.
 */
export function resolveContainedWindowsBatchCommand(
	cwd: string,
	fileName: string,
	args: string[],
	deps: WindowsBatchDeps = _internals,
): string[] | null {
	if (deps.platform() !== 'win32') return null;
	const candidate = path.join(cwd, fileName);
	if (!isRegularFile(candidate, deps)) return null;

	let canonicalCwd: string;
	let canonicalCandidate: string;
	try {
		canonicalCwd = deps.realpathSync(cwd);
		canonicalCandidate = deps.realpathSync(candidate);
	} catch {
		return null;
	}
	const relative = path.relative(canonicalCwd, canonicalCandidate);
	if (
		relative === '' ||
		relative.startsWith('..') ||
		path.isAbsolute(relative)
	) {
		return null;
	}
	return buildWindowsBatchCommand(canonicalCandidate, args, deps);
}

/**
 * True when `command` is a cmd.exe launcher that must be spawned with
 * `windowsVerbatimArguments: true` (win32 only).
 */
export function isWindowsCommandInterpreterLaunch(
	command: readonly string[],
	platform: NodeJS.Platform = _internals.platform(),
): boolean {
	return (
		platform === 'win32' &&
		command.length > 0 &&
		path.win32.basename(command[0]).toLowerCase() === 'cmd.exe'
	);
}

/** Default dependencies (live process/filesystem); a DI seam for tests. */
export const _internals: WindowsBatchDeps = {
	platform: () => process.platform,
	comSpec: () => process.env.ComSpec,
	realpathSync: (candidate) => fs.realpathSync(candidate),
	statSync: (candidate) => fs.statSync(candidate),
};
