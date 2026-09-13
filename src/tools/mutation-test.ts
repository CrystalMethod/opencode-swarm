import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { z } from 'zod';
import {
	executeMutationSuite,
	type MutationReport,
	validateTestCommand,
} from '../mutation/engine.js';
import {
	evaluateMutationGate,
	type MutationGateResult,
} from '../mutation/gate.js';
import {
	analyzeImpact,
	_internals as impactInternals,
	MAX_IMPACT_CACHE_BYTES,
} from '../test-impact/analyzer.js';
import { MAX_SAFE_TEST_FILES } from '../test-impact/constants.js';
import { createSwarmTool } from './create-tool';
import { resolveWorkingDirectory } from './resolve-working-directory';

type SelectionKind = 'explicit' | 'impact';
type CacheDisposition = 'preserved' | 'refreshed' | 'unavailable';

interface MutationSelection {
	kind: SelectionKind;
	sourceFiles: string[];
	sourceFileCount?: number;
	sourceFilesTruncated?: boolean;
	testFiles: string[];
	cap: number;
	fallbackReason: string | null;
	evaluable: boolean;
	cacheDisposition?: CacheDisposition;
}

interface MutationToolArgs {
	patches: Array<{
		id: string;
		filePath: string;
		functionName: string;
		mutationType: string;
		patch: string;
		lineNumber?: number;
	}>;
	files?: string[];
	test_command: string[];
	pass_threshold?: number;
	warn_threshold?: number;
	working_directory?: string;
}

function contentDigest(filePath: string): string | null {
	return boundedContentDigest(filePath);
}

function boundedContentDigest(
	filePath: string,
	maxBytes?: number,
): string | null {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, 'r');
		const stat = fs.fstatSync(fd);
		if (maxBytes !== undefined && stat.size > maxBytes) return null;
		const hash = createHash('sha256');
		const chunk = Buffer.allocUnsafe(64 * 1024);
		let totalBytes = 0;
		while (true) {
			const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, totalBytes);
			if (bytesRead === 0) break;
			totalBytes += bytesRead;
			if (maxBytes !== undefined && totalBytes > maxBytes) return null;
			hash.update(chunk.subarray(0, bytesRead));
		}
		return hash.digest('hex');
	} catch {
		return null;
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// best effort cleanup
			}
		}
	}
}

type CacheGeneration = {
	digest: string;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	dev: number;
	ino: number;
};

function readCacheGeneration(filePath: string): CacheGeneration | null {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, 'r');
		const stat = fs.fstatSync(fd);
		if (stat.size > MAX_IMPACT_CACHE_BYTES) return null;
		const hash = createHash('sha256');
		const chunk = Buffer.allocUnsafe(64 * 1024);
		let totalBytes = 0;
		while (true) {
			const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, totalBytes);
			if (bytesRead === 0) break;
			totalBytes += bytesRead;
			if (totalBytes > MAX_IMPACT_CACHE_BYTES) return null;
			hash.update(chunk.subarray(0, bytesRead));
		}
		const digest = hash.digest('hex');
		const finalStat = fs.fstatSync(fd);
		if (
			finalStat.dev !== stat.dev ||
			finalStat.ino !== stat.ino ||
			finalStat.size !== totalBytes ||
			finalStat.size > MAX_IMPACT_CACHE_BYTES ||
			finalStat.mtimeMs !== stat.mtimeMs ||
			finalStat.ctimeMs !== stat.ctimeMs
		) {
			return null;
		}
		return {
			digest,
			size: finalStat.size,
			mtimeMs: finalStat.mtimeMs,
			ctimeMs: finalStat.ctimeMs,
			dev: finalStat.dev,
			ino: finalStat.ino,
		};
	} catch {
		return null;
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// best effort cleanup
			}
		}
	}
}

function sameCacheGeneration(
	left: CacheGeneration | null,
	right: CacheGeneration | null,
): boolean {
	return (
		left !== null &&
		right !== null &&
		left.digest === right.digest &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs &&
		left.dev === right.dev &&
		left.ino === right.ino
	);
}

function normalizeWorkspaceFile(
	value: unknown,
	cwd: string,
	requireExisting: boolean,
): { value: string; absolute: string } | { error: string } {
	if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
		return { error: 'file paths must be non-empty strings without null bytes' };
	}
	const slashPath = value.replace(/\\/g, '/');
	if (
		path.posix.isAbsolute(slashPath) ||
		path.win32.isAbsolute(value) ||
		/^[A-Za-z]:/.test(value)
	) {
		return { error: `absolute file path is not allowed: ${value}` };
	}
	const normalized = path.posix.normalize(slashPath);
	if (
		normalized === '.' ||
		normalized === '..' ||
		normalized.startsWith('../')
	) {
		return { error: `file path escapes the project root: ${value}` };
	}
	const absolute = path.resolve(cwd, normalized);
	const relative = _internals.pathRelative(cwd, absolute).replace(/\\/g, '/');
	if (isWorkspaceRelativeOutsideRoot(relative)) {
		return { error: `file path escapes the project root: ${value}` };
	}
	if (requireExisting) {
		try {
			if (!fs.statSync(absolute).isFile()) {
				return { error: `file path is not a regular file: ${value}` };
			}
			const root = fs.realpathSync(cwd);
			const real = fs.realpathSync(absolute);
			const realRelative = _internals
				.pathRelative(root, real)
				.replace(/\\/g, '/');
			if (isWorkspaceRelativeOutsideRoot(realRelative)) {
				return {
					error: `file path resolves outside the project root: ${value}`,
				};
			}
		} catch {
			return { error: `file path does not exist or is inaccessible: ${value}` };
		}
	}
	return { value: relative, absolute };
}

function isWorkspaceRelativeOutsideRoot(relative: string): boolean {
	return (
		relative === '' ||
		relative === '..' ||
		relative.startsWith('../') ||
		path.posix.isAbsolute(relative) ||
		path.win32.isAbsolute(relative)
	);
}

export const _internals: {
	pathRelative: typeof path.relative;
	normalizeWorkspaceFile: typeof normalizeWorkspaceFile;
} = {
	pathRelative: path.relative,
	normalizeWorkspaceFile,
};

function workspaceFileIdentity(filePath: string): string {
	let canonical = path.normalize(filePath);
	try {
		canonical = path.normalize(fs.realpathSync(filePath));
	} catch {
		// normalizeWorkspaceFile already checked existence for callers that need
		// identity; retain the lexical path as a conservative fallback.
	}
	return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function normalizeExplicitFiles(
	files: unknown,
	cwd: string,
): { files: string[]; error?: string; overflow?: boolean } {
	if (!Array.isArray(files) || files.length === 0) {
		return {
			files: [],
			error: 'files must be a non-empty array of file paths',
		};
	}
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const file of files) {
		if (typeof file !== 'string' || file.startsWith('-')) {
			return { files: normalized, error: 'files contains an unsafe path' };
		}
		const result = normalizeWorkspaceFile(file, cwd, true);
		if ('error' in result) return { files: normalized, error: result.error };
		const identity = workspaceFileIdentity(result.absolute);
		if (!seen.has(identity)) {
			seen.add(identity);
			normalized.push(result.value);
		}
	}
	return {
		files: normalized,
		overflow: normalized.length > MAX_SAFE_TEST_FILES,
	};
}

function normalizeImpactFiles(files: unknown, cwd: string): string[] {
	if (!Array.isArray(files)) return [];
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const file of files) {
		const candidate =
			typeof file === 'string' && path.isAbsolute(file)
				? path.relative(cwd, file)
				: file;
		const result = normalizeWorkspaceFile(candidate, cwd, true);
		if ('error' in result) continue;
		const identity = workspaceFileIdentity(result.absolute);
		if (seen.has(identity)) continue;
		seen.add(identity);
		normalized.push(result.value);
	}
	return normalized;
}

function skipResult(
	selection: MutationSelection,
	outcome: 'unevaluable' | 'scope_exceeded' | 'failure',
	error: string,
): string {
	return JSON.stringify(
		{
			success: false,
			verdict: 'skip',
			outcome,
			evaluable: false,
			selection,
			error,
			message: error,
			totalMutants: 0,
			killed: 0,
			survived: 0,
		},
		null,
		2,
	);
}

export const mutation_test: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Execute mutation testing with pre-generated patches — applies each mutant patch, runs a bounded explicit or impact-derived test selection, and evaluates kill rate against quality gate thresholds. Returns verdict (pass/warn/fail/skip) with selection evidence, per-function kill rates, and survived mutant details.',
		args: {
			patches: z
				.array(
					z.object({
						id: z.string().describe('Unique identifier for the mutation patch'),
						filePath: z.string().describe('File path to apply the patch to'),
						functionName: z.string().describe('Function being mutated'),
						mutationType: z
							.string()
							.describe(
								'Type of mutation (e.g., off_by_one, null_substitution)',
							),
						patch: z.string().describe('Unified diff patch content'),
						lineNumber: z
							.number()
							.optional()
							.describe('Line number of the mutation'),
					}),
				)
				.describe(
					'Array of MutationPatch objects — pre-generated mutation patches to execute',
				),
			files: z
				.array(z.string())
				.optional()
				.describe(
					'Optional explicit test file paths to run against mutants. When omitted, impacted tests are derived from the mutated source files.',
				),
			test_command: z
				.array(z.string())
				.describe(
					'Test command as array of strings (e.g., ["npx", "vitest", "--run"])',
				),
			pass_threshold: z
				.number()
				.optional()
				.describe('Kill rate threshold for pass verdict (default: 0.80)'),
			warn_threshold: z
				.number()
				.optional()
				.describe('Kill rate threshold for warn verdict (default: 0.60)'),
			working_directory: z
				.string()
				.optional()
				.describe(
					'Project root directory. Defaults to current working directory.',
				),
		},
		async execute(
			args: unknown,
			directory: string,
			_ctx?: ToolContext,
		): Promise<string> {
			const typedArgs = args as MutationToolArgs;
			let activeSelection: MutationSelection | undefined;

			try {
				if (
					!typedArgs.test_command ||
					!Array.isArray(typedArgs.test_command) ||
					typedArgs.test_command.length === 0
				) {
					return JSON.stringify(
						{
							error: 'test_command must be a non-empty array of strings',
							success: false,
						},
						null,
						2,
					);
				}

				if (!typedArgs.test_command.every((c) => typeof c === 'string')) {
					return JSON.stringify(
						{
							error: 'test_command must contain only strings',
							success: false,
						},
						null,
						2,
					);
				}

				const cmdValidationError = validateTestCommand(typedArgs.test_command);
				if (cmdValidationError) {
					return JSON.stringify(
						{
							error: cmdValidationError,
							success: false,
						},
						null,
						2,
					);
				}

				if (
					!typedArgs.patches ||
					!Array.isArray(typedArgs.patches) ||
					typedArgs.patches.length === 0
				) {
					return JSON.stringify(
						{
							error:
								'patches must be a non-empty array of MutationPatch objects',
							success: false,
						},
						null,
						2,
					);
				}

				const resolved = resolveWorkingDirectory(
					typedArgs.working_directory,
					directory,
				);
				if (!resolved.success) {
					return JSON.stringify(
						{ success: false, error: resolved.message },
						null,
						2,
					);
				}
				const cwd = resolved.directory;
				const passThreshold = typedArgs.pass_threshold ?? 0.8;
				const warnThreshold = typedArgs.warn_threshold ?? 0.6;
				// Keep path-bearing selection evidence bounded even when callers send a
				// large patch list. The final entry is a bounded truncation sentinel;
				// sourceFileCount reports the retained evidence count.
				const sourcePaths: string[] = [];
				const sourcePathKeys = new Set<string>();
				let sourcePathsTruncated = false;
				for (const patch of typedArgs.patches) {
					if (typeof patch?.filePath !== 'string') continue;
					if (sourcePathKeys.has(patch.filePath)) continue;
					sourcePathKeys.add(patch.filePath);
					sourcePaths.push(patch.filePath);
					if (sourcePaths.length >= MAX_SAFE_TEST_FILES + 1) {
						sourcePathsTruncated = true;
						break;
					}
				}
				const sourceEvidence = {
					sourceFileCount: sourcePaths.length,
					sourceFilesTruncated: sourcePathsTruncated,
				};
				const normalizedSourcePaths: string[] = [];
				for (const sourcePath of sourcePaths) {
					const normalized = normalizeWorkspaceFile(sourcePath, cwd, true);
					if ('error' in normalized) {
						return skipResult(
							{
								kind: typedArgs.files === undefined ? 'impact' : 'explicit',
								sourceFiles: sourcePaths,
								...sourceEvidence,
								testFiles: [],
								cap: MAX_SAFE_TEST_FILES,
								fallbackReason: normalized.error,
								evaluable: false,
							},
							'unevaluable',
							normalized.error,
						);
					}
					normalizedSourcePaths.push(normalized.value);
				}

				let selectedTestFiles: string[];
				let selectionKind: SelectionKind;
				let fallbackReason: string | null = null;
				if (typedArgs.files !== undefined) {
					selectionKind = 'explicit';
					const explicit = normalizeExplicitFiles(typedArgs.files, cwd);
					if (explicit.error) {
						return skipResult(
							{
								kind: selectionKind,
								sourceFiles: normalizedSourcePaths,
								...sourceEvidence,
								testFiles: explicit.files,
								cap: MAX_SAFE_TEST_FILES,
								fallbackReason: explicit.error,
								evaluable: false,
							},
							'unevaluable',
							explicit.error,
						);
					}
					selectedTestFiles = explicit.files;
					if (explicit.overflow) {
						const reason = `Explicit test selection exceeds the safe maximum of ${MAX_SAFE_TEST_FILES} unique files`;
						return skipResult(
							{
								kind: selectionKind,
								sourceFiles: normalizedSourcePaths,
								...sourceEvidence,
								testFiles: selectedTestFiles.slice(0, MAX_SAFE_TEST_FILES + 1),
								cap: MAX_SAFE_TEST_FILES,
								fallbackReason: reason,
								evaluable: false,
							},
							'scope_exceeded',
							reason,
						);
					}
				} else {
					selectionKind = 'impact';
					if (normalizedSourcePaths.length === 0) {
						return skipResult(
							{
								kind: selectionKind,
								sourceFiles: [],
								...sourceEvidence,
								testFiles: [],
								cap: MAX_SAFE_TEST_FILES,
								fallbackReason: 'No safe mutated source files were provided',
								evaluable: false,
							},
							'unevaluable',
							'No safe mutated source files were provided',
						);
					}
					let impactResult: Awaited<ReturnType<typeof analyzeImpact>>;
					try {
						const analyzer = impactInternals.analyzeImpact ?? analyzeImpact;
						impactResult = await analyzer(
							normalizedSourcePaths,
							cwd,
							MAX_SAFE_TEST_FILES + 1,
						);
					} catch (error) {
						const reason = `Impact analysis unavailable: ${error instanceof Error ? error.message : String(error)}`;
						return skipResult(
							{
								kind: selectionKind,
								sourceFiles: normalizedSourcePaths,
								...sourceEvidence,
								testFiles: [],
								cap: MAX_SAFE_TEST_FILES,
								fallbackReason: reason,
								evaluable: false,
							},
							'failure',
							reason,
						);
					}
					selectedTestFiles = normalizeImpactFiles(
						impactResult.impactedTests,
						cwd,
					);
					if (
						impactResult.budgetExceeded ||
						selectedTestFiles.length > MAX_SAFE_TEST_FILES
					) {
						const reason = `Impact-derived test selection exceeds the safe maximum of ${MAX_SAFE_TEST_FILES} unique files`;
						return skipResult(
							{
								kind: selectionKind,
								sourceFiles: normalizedSourcePaths,
								...sourceEvidence,
								testFiles: selectedTestFiles.slice(0, MAX_SAFE_TEST_FILES + 1),
								cap: MAX_SAFE_TEST_FILES,
								fallbackReason: reason,
								evaluable: false,
							},
							'scope_exceeded',
							reason,
						);
					}
					if (selectedTestFiles.length === 0) {
						fallbackReason =
							'No impacted test files were found for the mutated source files';
						return skipResult(
							{
								kind: selectionKind,
								sourceFiles: normalizedSourcePaths,
								...sourceEvidence,
								testFiles: [],
								cap: MAX_SAFE_TEST_FILES,
								fallbackReason,
								evaluable: false,
							},
							'unevaluable',
							fallbackReason,
						);
					}
				}

				const selection: MutationSelection = {
					kind: selectionKind,
					sourceFiles: normalizedSourcePaths,
					...sourceEvidence,
					testFiles: selectedTestFiles,
					cap: MAX_SAFE_TEST_FILES,
					fallbackReason,
					evaluable: true,
				};
				activeSelection = selection;

				const sourceDigests = new Map<string, string | null>();
				for (const sourcePath of normalizedSourcePaths) {
					const normalized = normalizeWorkspaceFile(sourcePath, cwd, false);
					if ('value' in normalized) {
						sourceDigests.set(
							normalized.value,
							contentDigest(normalized.absolute),
						);
					}
				}
				const testDigests = new Map<string, string | null>();
				for (const testPath of selectedTestFiles) {
					const normalized = normalizeWorkspaceFile(testPath, cwd, false);
					if ('value' in normalized) {
						testDigests.set(
							normalized.value,
							contentDigest(normalized.absolute),
						);
					}
				}
				const cachePath = path.join(cwd, '.swarm', 'cache', 'impact-map.json');
				const cacheBefore = readCacheGeneration(cachePath);

				// Build source files map for equivalence detection
				const sourceFiles = new Map<string, string>();
				for (const filePath of sourcePaths) {
					try {
						const resolvedPath = path.resolve(cwd, filePath);
						sourceFiles.set(filePath, fs.readFileSync(resolvedPath, 'utf-8'));
					} catch {
						// Skip files that can't be read
					}
				}

				const report: MutationReport = await executeMutationSuite(
					typedArgs.patches,
					typedArgs.test_command,
					selectedTestFiles,
					cwd,
					undefined, // budgetMs
					undefined, // onProgress
					sourceFiles.size > 0 ? sourceFiles : undefined,
				);
				const cacheAfter = readCacheGeneration(cachePath);

				let cacheChanged = false;
				for (const [filePath, before] of sourceDigests) {
					const after = contentDigest(path.resolve(cwd, filePath));
					if (after !== before) cacheChanged = true;
				}
				for (const [filePath, before] of testDigests) {
					const after = contentDigest(path.resolve(cwd, filePath));
					if (after !== before) cacheChanged = true;
				}
				if (cacheChanged) {
					// Never unlink a cache path here. The analyzer owns cache
					// replacement and will rebuild this stale generation on its next
					// bounded read, while preserving any concurrent atomic refresh.
					selection.cacheDisposition = 'preserved';
				} else if (sameCacheGeneration(cacheBefore, cacheAfter)) {
					selection.cacheDisposition = 'preserved';
				} else if (cacheAfter !== null) {
					selection.cacheDisposition = 'refreshed';
				} else {
					selection.cacheDisposition = 'unavailable';
				}

				const result: MutationGateResult = evaluateMutationGate(
					report,
					passThreshold,
					warnThreshold,
				);

				return JSON.stringify(
					{
						...result,
						success: true,
						outcome: 'success',
						evaluable: true,
						selection,
						mutation: {
							totalMutants: report.totalMutants,
							killed: report.killed,
							survived: report.survived,
							equivalent: report.equivalent,
							skipped: report.skipped,
							errors: report.errors,
						},
					},
					null,
					2,
				);
			} catch (e) {
				const reason =
					e instanceof Error
						? `mutation_test failed: ${e.message}`
						: 'mutation_test failed: unknown error';
				if (activeSelection) {
					return skipResult(
						{
							...activeSelection,
							evaluable: false,
							fallbackReason: reason,
						},
						'failure',
						reason,
					);
				}
				return JSON.stringify(
					{
						error: reason,
						success: false,
					},
					null,
					2,
				);
			}
		},
	});
