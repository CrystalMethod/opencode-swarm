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
	opendirSync?: (directory: string) => ShellDirectory;
	realpathSync?: (file: string) => string;
	lstatSync?: (file: string) => fs.Stats;
}

interface ShellDirectory {
	readSync(): fs.Dirent | null;
	closeSync(): void;
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
const MAX_SHELL_FILE_BYTES = 4 * 1024 * 1024;
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

function sameFileIdentityForScan(left: fs.Stats, right: fs.Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function shouldExcludePath(root: string, candidate: string): boolean {
	const relative = toPosixRelative(root, candidate);
	return relative
		.split('/')
		.some((segment) => EXCLUDED_PATH_SEGMENTS.has(segment.toLowerCase()));
}

function isContainedPath(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative === '' ||
		(relative !== '..' &&
			!relative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relative))
	);
}

type ShellEntryType =
	| 'directory'
	| 'file'
	| 'symbolic-link'
	| 'special'
	| 'unknown';

interface FileSystemEntryTypeProbe {
	isDirectory(): boolean;
	isFile(): boolean;
	isSymbolicLink(): boolean;
	isBlockDevice(): boolean;
	isCharacterDevice(): boolean;
	isFIFO(): boolean;
	isSocket(): boolean;
}

function classifyEntry(entry: FileSystemEntryTypeProbe): ShellEntryType {
	// Check links before directories so a malformed or platform-specific entry
	// can never cause the walk to follow a symlink.
	if (entry.isSymbolicLink()) return 'symbolic-link';
	if (entry.isDirectory()) return 'directory';
	if (entry.isFile()) return 'file';
	if (
		entry.isBlockDevice() ||
		entry.isCharacterDevice() ||
		entry.isFIFO() ||
		entry.isSocket()
	)
		return 'special';
	return 'unknown';
}

function walkShFiles(
	startDir: string,
	repoRoot: string,
	canonicalRepoRoot: string,
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
		let directory: ShellDirectory | undefined;
		let hitEntryLimit = false;
		const entries: fs.Dirent[] = [];
		const visitEntry = (entry: fs.Dirent): void => {
			const full = path.join(current, entry.name);
			if (shouldExcludePath(repoRoot, full)) return;
			let entryType = classifyEntry(entry);
			if (entryType === 'unknown') {
				// Filesystems that do not populate dirent.d_type report every
				// predicate as false. Resolve those entries with lstat so the
				// scanner neither drops a shell file nor follows a symlink.
				try {
					entryType = classifyEntry(
						deps.lstatSync ? deps.lstatSync(full) : fs.lstatSync(full),
					);
				} catch {
					errors.push(
						`could not inspect ${toPosixRelative(repoRoot, full)} after unknown directory entry type`,
					);
					return;
				}
				if (entryType === 'unknown') {
					errors.push(
						`could not classify ${toPosixRelative(repoRoot, full)} after unknown directory entry type`,
					);
					return;
				}
			}
			if (entryType === 'symbolic-link' || entryType === 'special') return;
			let canonical: string;
			try {
				canonical = deps.realpathSync
					? deps.realpathSync(full)
					: fs.realpathSync.native(full);
			} catch {
				errors.push(`could not canonicalize ${toPosixRelative(repoRoot, full)}`);
				return;
			}
			if (!isContainedPath(canonicalRepoRoot, canonical)) {
				errors.push(
					`refusing path outside repository ${toPosixRelative(repoRoot, full)}`,
				);
				return;
			}
			if (entryType === 'directory') {
				stack.push(canonical);
				return;
			}
			if (entryType === 'file' && entry.name.endsWith('.sh')) {
				out.push(canonical);
			}
		};
		try {
			if (deps.readdirSync) {
				// Keep the synchronous DI seam used by the discovery tests. The
				// production path below streams entries so a large directory is
				// bounded before the scanner spends time sorting/materializing it.
				for (const entry of deps.readdirSync(current)) {
					if (++visitedEntries > maxEntries) {
						hitEntryLimit = true;
						break;
					}
					entries.push(entry);
				}
			} else {
				directory = (deps.opendirSync ?? fs.opendirSync)(current);
				while (!hitEntryLimit) {
					const entry = directory.readSync();
					if (entry === null) break;
					if (++visitedEntries > maxEntries) {
						hitEntryLimit = true;
						break;
					}
					entries.push(entry);
				}
			}
		} catch {
			errors.push(`could not enumerate ${toPosixRelative(repoRoot, current)}`);
		} finally {
			if (directory) {
				try {
					directory.closeSync();
				} catch {
					errors.push(`could not close ${toPosixRelative(repoRoot, current)}`);
				}
			}
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) visitEntry(entry);
		if (hitEntryLimit) {
			errors.push(
				`entry limit ${maxEntries} exceeded under ${toPosixRelative(repoRoot, startDir)}`,
			);
			return { files: out, errors };
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
	let canonicalRoot: string;
	try {
		canonicalRoot = fs.realpathSync.native(root);
	} catch {
		return {
			files: [],
			errors: [`could not canonicalize repository root ${root}`],
		};
	}
	for (const scanRoot of roots) {
		const status = scanRootStatus(root, scanRoot, deps);
		if (status.error) errors.push(status.error);
		if (!status.present || status.linked) continue;
		const discovered = walkShFiles(
			scanRoot,
			root,
			canonicalRoot,
			maxEntries,
			deps,
		);
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

function readBoundedShellFile(
	filePath: string,
	canonicalRepoRoot: string,
): { content?: string; error?: string } {
	let pathStat: fs.Stats;
	try {
		pathStat = fs.lstatSync(filePath);
	} catch {
		return { error: `could not inspect ${filePath}` };
	}
	if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
		return { error: `shell file is not a regular file ${filePath}` };
	}
	let canonicalPath: string;
	try {
		canonicalPath = fs.realpathSync.native(filePath);
	} catch {
		return { error: `could not canonicalize ${filePath}` };
	}
	if (!isContainedPath(canonicalRepoRoot, canonicalPath)) {
		return { error: `refusing path outside repository ${filePath}` };
	}
	if (pathStat.size > MAX_SHELL_FILE_BYTES) {
		return {
			error: `shell file exceeds ${MAX_SHELL_FILE_BYTES} bytes ${filePath}`,
		};
	}

	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(
			filePath,
			fs.constants.O_RDONLY |
				((fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0),
		);
		const openedStat = fs.fstatSync(descriptor);
		if (
			!openedStat.isFile() ||
			openedStat.dev !== pathStat.dev ||
			openedStat.ino !== pathStat.ino
		) {
			return { error: `shell file changed while being opened ${filePath}` };
		}
		if (openedStat.size > MAX_SHELL_FILE_BYTES) {
			return {
				error: `shell file exceeds ${MAX_SHELL_FILE_BYTES} bytes ${filePath}`,
			};
		}
		// Read at most one byte beyond the cap. This keeps the memory bound even
		// if a writer grows the file after the fstat above.
		const bytes = Buffer.alloc(MAX_SHELL_FILE_BYTES + 1);
		const bytesRead = fs.readSync(
			descriptor,
			bytes,
			0,
			bytes.byteLength,
			0,
		);
		const afterReadStat = fs.fstatSync(descriptor);
		if (
			!sameFileIdentityForScan(pathStat, afterReadStat) ||
			afterReadStat.size > MAX_SHELL_FILE_BYTES
		) {
			return { error: `shell file changed while being read ${filePath}` };
		}
		if (bytesRead > MAX_SHELL_FILE_BYTES) {
			return {
				error: `shell file exceeds ${MAX_SHELL_FILE_BYTES} bytes ${filePath}`,
			};
		}
		return { content: bytes.subarray(0, bytesRead).toString('utf8') };
	} catch {
		return { error: `could not read ${filePath}` };
	} finally {
		if (descriptor !== undefined) {
			try {
				fs.closeSync(descriptor);
			} catch {
				// The primary read error is more actionable than a close failure.
			}
		}
	}
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
	let canonicalRepoRoot: string;
	try {
		canonicalRepoRoot = fs.realpathSync.native(repoRoot);
	} catch {
		canonicalRepoRoot = path.resolve(repoRoot);
	}
	const readErrors: string[] = [];
	const files: Array<{ file: string; content: string }> = [];
	for (const file of discovery.files) {
		if (path.resolve(file) === path.resolve(selfShim)) continue;
		const read = readBoundedShellFile(file, canonicalRepoRoot);
		if (read.content === undefined) {
			readErrors.push(read.error ?? `could not read ${file}`);
			continue;
		}
		files.push({ file: toPosixRelative(repoRoot, file), content: read.content });
	}
	const result = evaluateBashPortability(files);
	for (const error of [...discovery.errors, ...readErrors]) {
		result.messages.unshift(`ERROR: shell discovery ${error}`);
	}
	if (discovery.errors.length > 0 || readErrors.length > 0) {
		result.messages.push(
			`Shell discovery errors: ${discovery.errors.length + readErrors.length}; portability scan is incomplete.`,
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
