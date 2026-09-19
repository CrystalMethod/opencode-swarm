import * as fs from 'node:fs';
import * as path from 'node:path';
import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import { loadPluginConfigWithMeta } from '../config/index.js';
import { recordTodoScanEvidence } from '../gate-evidence.js';
import { escapeRegex } from '../utils';
import * as logger from '../utils/logger.js';
import { isStrictTaskId } from '../validation/task-id';
import { createSwarmTool } from './create-tool';

// ============ Constants ============
const MAX_TEXT_LENGTH = 200;
const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1MB per file
/** Cap on evidence detail lines recorded per task (issue #2581). */
const MAX_RECORDED_DETAILS = 50;

// Supported file extensions (text-based source files only)
const SUPPORTED_EXTENSIONS = new Set([
	'.ts',
	'.tsx',
	'.js',
	'.jsx',
	'.py',
	'.rs',
	'.ps1',
	'.go',
	'.java',
	'.c',
	'.cpp',
	'.h',
	'.cs',
	'.rb',
	'.php',
	'.blade.php',
	'.swift',
	'.kt',
]);

// Directories to skip during scanning
const SKIP_DIRECTORIES = new Set([
	'node_modules',
	'dist',
	'build',
	'.git',
	'.swarm',
	'coverage',
]);

// Priority mapping: FIXME/HACK/XXX → high, TODO/WARN → medium, NOTE → low
const PRIORITY_MAP: Record<string, 'high' | 'medium' | 'low'> = {
	FIXME: 'high',
	HACK: 'high',
	XXX: 'high',
	TODO: 'medium',
	WARN: 'medium',
	NOTE: 'low',
};

// Shell metacharacters that are not allowed in tags
const SHELL_METACHAR_REGEX = /[;&|%$`\\]/;

// ============ Types ============
interface TodoEntry {
	file: string;
	line: number;
	tag: string;
	text: string;
	priority: 'high' | 'medium' | 'low';
}

interface TodoExtractResult {
	total: number;
	byPriority: {
		high: number;
		medium: number;
		low: number;
	};
	entries: TodoEntry[];
}

interface TodoExtractError {
	error: string;
	total: 0;
	byPriority: { high: 0; medium: 0; low: 0 };
	entries: [];
}

// ============ Validation ============
import {
	containsControlChars,
	containsPathTraversal,
} from '../utils/path-security';

function validateTagsInput(tags: string): string | null {
	if (!tags || tags.length === 0) {
		return 'tags cannot be empty';
	}
	if (containsControlChars(tags)) {
		return 'tags contains control characters';
	}
	if (SHELL_METACHAR_REGEX.test(tags)) {
		return 'tags contains shell metacharacters (;|&$`\\)';
	}
	// Only allow alphanumeric characters, commas, and spaces
	if (!/^[a-zA-Z0-9,\s]+$/.test(tags)) {
		return 'tags contains invalid characters (only alphanumeric, commas, spaces allowed)';
	}
	return null;
}

function validatePathsInput(
	paths: string,
	cwd: string,
): { error: string | null; resolvedPath: string | null } {
	if (!paths || paths.length === 0) {
		return { error: null, resolvedPath: cwd }; // Default to cwd
	}

	if (containsControlChars(paths)) {
		return { error: 'paths contains control characters', resolvedPath: null };
	}

	if (containsPathTraversal(paths)) {
		return { error: 'paths contains path traversal', resolvedPath: null };
	}

	try {
		const resolvedPath = path.resolve(paths);

		// Security check: resolved path must be within cwd
		const normalizedCwd = path.resolve(cwd);
		const normalizedResolved = path.resolve(resolvedPath);

		if (!normalizedResolved.startsWith(normalizedCwd)) {
			return {
				error: 'paths must be within the current working directory',
				resolvedPath: null,
			};
		}

		return { error: null, resolvedPath };
	} catch (e) {
		return {
			error: e instanceof Error ? e.message : 'invalid paths',
			resolvedPath: null,
		};
	}
}

// ============ File Scanning ============
function isSupportedExtension(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase();
	return SUPPORTED_EXTENSIONS.has(ext);
}

function findSourceFiles(dir: string, files: string[] = []): string[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return files;
	}

	// Sort entries for deterministic scan order (case-insensitive)
	entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

	for (const entry of entries) {
		if (SKIP_DIRECTORIES.has(entry)) {
			continue;
		}

		const fullPath = path.join(dir, entry);

		let stat: fs.Stats;
		try {
			stat = fs.statSync(fullPath);
		} catch {
			continue;
		}

		if (stat.isDirectory()) {
			findSourceFiles(fullPath, files);
		} else if (stat.isFile()) {
			if (isSupportedExtension(fullPath)) {
				files.push(fullPath);
			}
		}
	}

	return files;
}

// ============ TODO Parsing ============
function parseTodoComments(
	content: string,
	filePath: string,
	tagsSet: Set<string>,
): TodoEntry[] {
	const entries: TodoEntry[] = [];
	const lines = content.split('\n');

	// Build regex pattern for all tags (escape metacharacters in user-provided tags)
	const tagPattern = Array.from(tagsSet).map(escapeRegex).join('|');
	const regex = new RegExp(`\\b(${tagPattern})\\b[:\\s]?`, 'i');

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const match = regex.exec(line);

		if (match) {
			const tag = match[1].toUpperCase();
			const priority = PRIORITY_MAP[tag] || 'medium';

			// Extract text after the tag
			let text = line.substring(match.index + match[0].length).trim();
			// Remove common comment markers
			text = text.replace(/^[/*\-\s]+/, '');

			// Truncate to max length
			if (text.length > MAX_TEXT_LENGTH) {
				text = `${text.substring(0, MAX_TEXT_LENGTH - 3)}...`;
			}

			entries.push({
				file: filePath,
				line: i + 1, // 1-indexed line numbers
				tag,
				text,
				priority,
			});
		}
	}

	return entries;
}

// ============ Tool Definition ============
export const todo_extract: ReturnType<typeof tool> = createSwarmTool({
	description:
		'Scan the codebase for TODO/FIXME/HACK/XXX/WARN/NOTE comments. Returns JSON with count by priority and sorted entries. Useful for identifying pending tasks and code issues. When task_id is provided and the todo_gate config is enabled (default), the high-priority scan is also recorded as todo_scan gate evidence for that task, consumed by check_gate_status and the phase-complete todo_gate gate.',
	args: {
		paths: z
			.string()
			.optional()
			.describe('Directory or file to scan (default: entire project/cwd)'),
		tags: z
			.string()
			.optional()
			.describe(
				'Comma-separated tags to search for (default: TODO,FIXME,HACK,XXX,WARN,NOTE)',
			),
		task_id: z
			.string()
			.regex(
				/^\d+\.\d+(\.\d+)*$/,
				'Task ID must be in N.M or N.M.P format (e.g., "1.1", "2.3.1")',
			)
			.optional()
			.describe(
				'Optional task ID (N.M format). When provided and todo_gate is enabled, the high-priority (FIXME/HACK/XXX) count is recorded as todo_scan gate evidence in .swarm/evidence/{task_id}.json',
			),
	},
	async execute(args: unknown, directory: string): Promise<string> {
		// Safe args extraction
		let paths: string | undefined;
		let tags: string | undefined;
		let taskId: string | undefined;
		try {
			if (args && typeof args === 'object') {
				const obj = args as Record<string, unknown>;
				paths = typeof obj.paths === 'string' ? obj.paths : undefined;
				tags = typeof obj.tags === 'string' ? obj.tags : undefined;
				taskId = typeof obj.task_id === 'string' ? obj.task_id : undefined;
			}
		} catch {
			// Malicious getter threw
		}

		// Get current working directory
		const cwd = directory;

		// Validate tags
		const tagsInput = tags || 'TODO,FIXME,HACK,XXX,WARN,NOTE';
		const tagsValidationError = validateTagsInput(tagsInput);
		if (tagsValidationError) {
			const errorResult: TodoExtractError = {
				error: `invalid tags: ${tagsValidationError}`,
				total: 0,
				byPriority: { high: 0, medium: 0, low: 0 },
				entries: [],
			};
			return JSON.stringify(errorResult, null, 2);
		}

		// Parse tags into a Set
		const tagsList = tagsInput
			.split(',')
			.map((t) => t.trim().toUpperCase())
			.filter((t) => t.length > 0);
		const tagsSet = new Set(tagsList);

		if (tagsSet.size === 0) {
			const errorResult: TodoExtractError = {
				error: 'invalid tags: no valid tags provided',
				total: 0,
				byPriority: { high: 0, medium: 0, low: 0 },
				entries: [],
			};
			return JSON.stringify(errorResult, null, 2);
		}

		// Validate paths
		const pathsInput = paths || cwd;
		const { error: pathsError, resolvedPath } = validatePathsInput(
			pathsInput,
			cwd,
		);

		if (pathsError) {
			const errorResult: TodoExtractError = {
				error: `invalid paths: ${pathsError}`,
				total: 0,
				byPriority: { high: 0, medium: 0, low: 0 },
				entries: [],
			};
			return JSON.stringify(errorResult, null, 2);
		}

		const scanPath = resolvedPath!;

		// Check if path exists
		if (!fs.existsSync(scanPath)) {
			const errorResult: TodoExtractError = {
				error: `path not found: ${pathsInput}`,
				total: 0,
				byPriority: { high: 0, medium: 0, low: 0 },
				entries: [],
			};
			return JSON.stringify(errorResult, null, 2);
		}

		// Collect files to scan
		const filesToScan: string[] = [];
		const stat = fs.statSync(scanPath);

		if (stat.isFile()) {
			// Single file - check if supported
			if (isSupportedExtension(scanPath)) {
				filesToScan.push(scanPath);
			} else {
				const errorResult: TodoExtractError = {
					error: `unsupported file extension: ${path.extname(scanPath)}`,
					total: 0,
					byPriority: { high: 0, medium: 0, low: 0 },
					entries: [],
				};
				return JSON.stringify(errorResult, null, 2);
			}
		} else {
			// Directory - find all supported files
			findSourceFiles(scanPath, filesToScan);
		}

		// Scan each file for TODO comments
		const allEntries: TodoEntry[] = [];

		for (const filePath of filesToScan) {
			try {
				const fileStat = fs.statSync(filePath);
				if (fileStat.size > MAX_FILE_SIZE_BYTES) {
					continue; // Skip oversized files
				}

				const content = fs.readFileSync(filePath, 'utf-8');
				const entries = parseTodoComments(content, filePath, tagsSet);
				allEntries.push(...entries);
			} catch {}
		}

		// Sort entries: high priority first, then by file name
		allEntries.sort((a, b) => {
			// High priority first
			const priorityOrder = { high: 0, medium: 1, low: 2 };
			const priorityDiff =
				priorityOrder[a.priority] - priorityOrder[b.priority];
			if (priorityDiff !== 0) return priorityDiff;

			// Then by file name (case-insensitive)
			return a.file.toLowerCase().localeCompare(b.file.toLowerCase());
		});

		// Count by priority
		const byPriority = {
			high: allEntries.filter((e) => e.priority === 'high').length,
			medium: allEntries.filter((e) => e.priority === 'medium').length,
			low: allEntries.filter((e) => e.priority === 'low').length,
		};

		const result: TodoExtractResult = {
			total: allEntries.length,
			byPriority,
			entries: allEntries,
		};

		// TODO-gate evidence producer (issue #2581): when the caller names a
		// task and the gate is enabled, record the high-priority scan as
		// supplementary gate evidence. Recording never changes the scan
		// output and never fails the tool: any error is debug-logged and
		// skipped. A custom tag set that omits any of the high-priority class
		// (FIXME/HACK/XXX) also skips recording — a filtered scan cannot
		// certify the task-level high-priority count the gate enforces.
		const HIGH_PRIORITY_TAGS = ['FIXME', 'HACK', 'XXX'];
		const coversHighPriorityClass = HIGH_PRIORITY_TAGS.every((tag) =>
			tagsSet.has(tag),
		);
		if (taskId && isStrictTaskId(taskId)) {
			if (!coversHighPriorityClass) {
				logger.log(
					'todo_extract: todo_scan evidence recording skipped — custom tags omit the FIXME/HACK/XXX high-priority class',
				);
			} else {
				try {
					const { config } = loadPluginConfigWithMeta(directory);
					if (config.todo_gate?.enabled !== false) {
						const highEntries = allEntries.filter(
							(entry) => entry.priority === 'high',
						);
						const detailLines = highEntries
							.slice(0, MAX_RECORDED_DETAILS)
							.map((entry) => {
								const relativeFile = path.relative(directory, entry.file);
								return `${relativeFile}:${entry.line} ${entry.tag} ${entry.text}`;
							});
						await recordTodoScanEvidence(directory, taskId, {
							priority: 'high',
							count: byPriority.high,
							details: detailLines,
							recorded_at: new Date().toISOString(),
						});
					}
				} catch (recordError) {
					logger.log(
						'todo_extract: todo_scan evidence recording skipped',
						recordError,
					);
				}
			}
		}

		return JSON.stringify(result, null, 2);
	},
});
