#!/usr/bin/env bun
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGit } from './gate-utils';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const SCRIPT_REPO_FALLBACK = path.resolve(SCRIPT_DIR, '..');
const GIT_TIMEOUT_MS = 30_000;

export interface BashPortabilityResult {
	messages: string[];
	violations: number;
	files: string[];
	exitCode: number;
}

export interface ShellDiscoveryResult {
	files: string[];
	errors: string[];
}

export interface ShellDiscoveryDeps {
	readdirSync?: (directory: string) => fs.Dirent[];
	realpathSync?: (file: string) => string;
	lstatSync?: (file: string) => fs.Stats;
}

export async function resolveRepoRoot(
	startDir: string = process.cwd(),
): Promise<string> {
	for (const candidate of [startDir, SCRIPT_REPO_FALLBACK]) {
		const proc = await runGit(['rev-parse', '--show-toplevel'], candidate, GIT_TIMEOUT_MS)
			.catch(() => null);
		if (!proc) {
			continue;
		}
		if (proc.exitCode === 0) {
			const top = proc.stdout.trim();
			if (top.length > 0) {
				return path.resolve(top);
			}
		}
	}
	return SCRIPT_REPO_FALLBACK;
}

function toPosixRelative(root: string, file: string): string {
	return path.relative(root, file).replace(/\\/g, '/');
}

const MAX_WALK_ENTRIES = 20_000;
const EXCLUDED_PATH_SEGMENTS = new Set([
	'.git',
	'.swarm',
	'build',
	'cache',
	'dist',
	'fixture',
	'fixtures',
	'generated',
	'node_modules',
	'test',
	'tests',
]);

function shouldExcludePath(root: string, candidate: string): boolean {
	const relative = toPosixRelative(root, candidate);
	return relative
		.split('/')
		.some((segment) => EXCLUDED_PATH_SEGMENTS.has(segment.toLowerCase()));
}

function walkShFiles(
	startDir: string,
	repoRoot: string,
	maxEntries = MAX_WALK_ENTRIES,
	deps: ShellDiscoveryDeps = {},
): ShellDiscoveryResult {
	const out: string[] = [];
	const errors: string[] = [];
	const stack = [startDir];
	let visitedEntries = 0;
	while (stack.length > 0 && visitedEntries < maxEntries) {
		const current = stack.pop()!;
		if (shouldExcludePath(repoRoot, current)) continue;
		let entries: fs.Dirent[];
		try {
			entries = (deps.readdirSync
				? deps.readdirSync(current)
				: fs
						.readdirSync(current, { withFileTypes: true }))
				.sort((a, b) => a.name.localeCompare(b.name));
		} catch {
			errors.push(`could not enumerate ${toPosixRelative(repoRoot, current)}`);
			continue;
		}
		for (let i = entries.length - 1; i >= 0; i--) {
			if (++visitedEntries > maxEntries) {
				errors.push(
					`entry limit ${maxEntries} exceeded under ${toPosixRelative(repoRoot, startDir)}`,
				);
				return { files: out, errors };
			}
			const entry = entries[i];
			const full = path.join(current, entry.name);
			if (shouldExcludePath(repoRoot, full)) continue;
			// Dirent.isDirectory() is deliberately used instead of stat(): a
			// symlinked directory must not be followed into an unbounded or
			// unrelated tree.
			if (entry.isDirectory() && !entry.isSymbolicLink()) {
				stack.push(full);
				continue;
			}
			if (entry.isFile() && entry.name.endsWith('.sh')) {
				out.push(full);
			}
		}
	}
	if (stack.length > 0) {
		errors.push(
			`entry limit ${maxEntries} exceeded under ${toPosixRelative(repoRoot, startDir)}`,
		);
	}
	return { files: out, errors };
}

function scanRootStatus(
	root: string,
	startDir: string,
	deps: ShellDiscoveryDeps,
): { present: boolean; linked: boolean; error?: string } {
	let stat: fs.Stats;
	try {
		stat = deps.lstatSync ? deps.lstatSync(startDir) : fs.lstatSync(startDir);
	} catch (error) {
		const code =
			typeof error === 'object' && error !== null && 'code' in error
				? String(error.code)
				: '';
		if (code === 'ENOENT') return { present: false, linked: false };
		return {
			present: false,
			linked: false,
			error: `could not inspect ${toPosixRelative(root, startDir)}`,
		};
	}
	if (stat.isSymbolicLink()) {
		return {
			present: true,
			linked: true,
			error: `skipping symlinked scan root ${toPosixRelative(root, startDir)}`,
		};
	}
	if (!stat.isDirectory()) {
		return {
			present: true,
			linked: false,
			error: `scan root is not a directory ${toPosixRelative(root, startDir)}`,
		};
	}
	return { present: true, linked: false };
}

export function discoverShellFiles(
	root: string,
	maxEntries = MAX_WALK_ENTRIES,
	deps: ShellDiscoveryDeps = {},
): ShellDiscoveryResult {
	const roots = [
		path.join(root, 'scripts'),
		path.join(root, '.opencode', 'skills'),
		path.join(root, '.claude', 'skills'),
		path.join(root, '.agents', 'skills'),
	];
	const seen = new Set<string>();
	const out: string[] = [];
	const errors: string[] = [];
	for (const scanRoot of roots) {
		const status = scanRootStatus(root, scanRoot, deps);
		if (status.error) errors.push(status.error);
		if (!status.present || status.linked) continue;
		const discovered = walkShFiles(scanRoot, root, maxEntries, deps);
		errors.push(...discovered.errors);
		for (const file of discovered.files) {
			let canonical: string;
			try {
				canonical = deps.realpathSync
					? deps.realpathSync(file)
					: fs.realpathSync.native(file);
			} catch {
				errors.push(`could not canonicalize ${toPosixRelative(root, file)}`);
				continue;
			}
			if (seen.has(canonical)) continue;
			seen.add(canonical);
			out.push(file);
		}
	}
	return { files: out.sort((a, b) => a.localeCompare(b)), errors };
}

function stripCommentOnlyLines(content: string): string {
	return content
		.split(/\r?\n/)
		.filter((line) => !/^[ \t]*#/.test(line))
		.join('\n');
}

function detectSetU(codeOnly: string): boolean {
	const pattern = /(^|[ \t])set[ \t]+-[^-]*u|(^|[ \t])set[ \t]+-[^-]*[eu][^-]*u/;
	return codeOnly.split('\n').some((line) => pattern.test(line));
}

function extractEmptyInitArrayNames(codeOnly: string): string[] {
	const out = new Set<string>();
	for (const line of codeOnly.split('\n')) {
		const match = line.match(
			/^[ \t]*(?:local[ \t]+|readonly[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=\([ \t]*\)/,
		);
		if (match) {
			out.add(match[1]);
		}
	}
	return [...out].sort();
}

export function evaluateBashPortability(
	files: Array<{ file: string; content: string }>,
): BashPortabilityResult {
	const messages: string[] = [];
	const violatingFiles: string[] = [];
	let violations = 0;

	for (const { file, content } of files) {
		let fileHasViolation = false;
		const codeOnly = stripCommentOnlyLines(content);

		if (
			/\b(declare|typeset|local|readonly)\b[ \t]+-[A-Za-z]*A[A-Za-z]*\b/.test(
				codeOnly,
			)
		) {
			messages.push(
				`ERROR: ${file} uses an associative array (declare/typeset/local/readonly -A) — bash 4+ only, not supported on macOS's bash 3.2.`,
			);
			messages.push(
				// Compatibility text is frozen to the pre-port Bash owner by issue #2094.
				'       Use a plain indexed array or parallel files instead (see scripts/check-invariants.sh for the established pattern).',
			);
			fileHasViolation = true;
		}

		if (
			/\bgrep\b[^|&;]*(-[A-Za-z]*P[A-Za-z]*\b|--perl-regexp\b)/.test(codeOnly)
		) {
			messages.push(
				'ERROR: ' +
					file +
					' uses `grep -P`/PCRE mode (any flag combination, or --perl-regexp) — BSD grep on macOS has no -P support at all.',
			);
			messages.push(
				'       Use `grep -E` with explicit alternation instead (see scripts/check-invariants.sh for the established pattern).',
			);
			fileHasViolation = true;
		}

		if (/(^|[^A-Za-z0-9_])coproc([^A-Za-z0-9_]|$)/.test(codeOnly)) {
			messages.push(
				`ERROR: ${file} uses \`coproc\` (bash 4+ keyword) — not supported on macOS's bash 3.2.`,
			);
			fileHasViolation = true;
		}

		if (/(^|[^A-Za-z0-9_])(mapfile|readarray)([^A-Za-z0-9_]|$)/.test(codeOnly)) {
			messages.push(
				`ERROR: ${file} uses \`mapfile\`/\`readarray\` (bash 4+ builtins) — not supported on macOS's bash 3.2.`,
			);
			messages.push(
				'       Use a while-read loop instead (see scripts/check-invariants.sh for the established pattern).',
			);
			fileHasViolation = true;
		}

		if (detectSetU(codeOnly)) {
			for (const arrName of extractEmptyInitArrayNames(codeOnly)) {
				const barePattern = `"${'${'}${arrName}[@]}"`;
				const guardedPattern = `${'${'}${arrName}[@]+"${'${'}${arrName}[@]}"}`;
				const bareHits = codeOnly
					.split('\n')
					.filter((line) => line.includes(barePattern));
				const unguarded = bareHits.filter(
					(line) => !line.includes(guardedPattern),
				);
				if (unguarded.length > 0) {
					messages.push(
						`ERROR: ${file} expands "\${${arrName}[@]}" under \`set -u\` but ${arrName}=() is initialized empty somewhere in the file.`,
					);
					messages.push(
						`       Under bash 3.2 (macOS) this aborts with 'unbound variable' when ${arrName} is empty (fixed in bash 4.4).`,
					);
					messages.push(
						`       Use the alternate-value form: \${${arrName}[@]+"\${${arrName}[@]}"}`
					);
					fileHasViolation = true;
				}
			}
		}

		if (fileHasViolation) {
			violations++;
			violatingFiles.push(file);
		}
	}

	messages.push('');
	messages.push('=== Summary ===');
	messages.push(`Files with bash4+-only constructs: ${violations}`);
	if (violations > 0) {
		messages.push('');
		messages.push('Violating files:');
		for (const file of violatingFiles) {
			messages.push(`  - ${file}`);
		}
	} else {
		messages.push(
			'No bash4+-only constructs found in scripts/, .opencode/skills/, .claude/skills/, or .agents/skills/.',
		);
	}

	return {
		messages,
		violations,
		files: violatingFiles,
		exitCode: violations > 0 ? 1 : 0,
	};
}

export async function main(
	startDir: string = process.cwd(),
	discoveryDeps: ShellDiscoveryDeps = {},
): Promise<number> {
	const repoRoot = await resolveRepoRoot(startDir);
	const selfShim = path.join(repoRoot, 'scripts', 'check-bash-portability.sh');
	const discovery = discoverShellFiles(repoRoot, MAX_WALK_ENTRIES, discoveryDeps);
	const files = discovery.files
		.filter((file) => path.resolve(file) !== path.resolve(selfShim))
		.map((file) => ({
			file: toPosixRelative(repoRoot, file),
			content: fs.readFileSync(file, 'utf-8'),
		}));
	const result = evaluateBashPortability(files);
	for (const error of discovery.errors) {
		result.messages.unshift(`ERROR: shell discovery ${error}`);
	}
	if (discovery.errors.length > 0) {
		result.messages.push(
			`Shell discovery errors: ${discovery.errors.length}; portability scan is incomplete.`,
		);
		result.exitCode = 1;
	}
	for (const line of result.messages) {
		console.log(line);
	}
	return result.exitCode;
}

const isDirectRun =
	typeof process.argv[1] === 'string' &&
	path.resolve(process.argv[1]) === path.resolve(SCRIPT_PATH);

if (isDirectRun) {
	void main()
		.then((exitCode) => {
			process.exit(exitCode);
		})
		.catch((error) => {
			throw error;
		});
}
