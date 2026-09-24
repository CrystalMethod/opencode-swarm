/**
 * Java backend.
 *
 * First-class Java `LanguageBackend` (DS-2). Overrides four hooks on top of
 * the registry-driven default:
 *   - `extractImports` reuses the shared `parseJavaImports` from
 *     `../java-extraction` (Approach A) rather than reimplementing a parser,
 *     mapping each parsed import to its `.specifier` string.
 *   - `selectTestFramework` prefers the Gradle wrapper `./gradlew` when
 *     present, then the Maven wrapper `./mvnw`, falling back to
 *     `defaultSelectTestFramework`. The wrapper checks are repo-local, so
 *     they do not depend on `gradle`/`mvn` being resolvable on PATH.
 *   - `selectEntryPoints` scans the tree for `.java` files declaring
 *     `public static void main`.
 *   - `selectFramework` detects Spring vs Servlet from pom.xml / build.gradle.
 *
 * Invariants identical to other backends — see `python.ts` and `go.ts` for
 * the rationale; `tests/unit/lang/backend-purity.test.ts` enforces them.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
	FrameworkSelection,
	LanguageBackend,
	TestFrameworkSelection,
} from '../backend';
import {
	defaultBackendFor,
	defaultSelectTestFramework,
} from '../default-backend';
import { parseJavaImports } from '../java-extraction';
import { LANGUAGE_REGISTRY } from '../profiles';

const PROFILE_ID = 'java';

/** Bounds for the entry-point tree scan — no unbounded recursion. */
const MAX_ENTRY_POINT_DEPTH = 8;
const MAX_ENTRY_POINT_FILES = 1000;
/**
 * Per-file size cap for the entry-point scan. A single oversized `.java` file
 * is skipped rather than read in full, keeping the synchronous init-path scan
 * bounded (a few hundred KB is far beyond any realistic main-class source).
 */
const MAX_ENTRY_POINT_FILE_BYTES = 256 * 1024;
/**
 * Total-byte cap across all `.java` files read during the entry-point scan.
 * The scan stops once cumulative bytes read would exceed this, bounding the
 * synchronous init-path work well under the ~50ms budget (the measured 80-90ms
 * warm-cache case read ~9.6MB; 512KB is ~5% of that).
 */
const MAX_ENTRY_POINT_TOTAL_BYTES = 512 * 1024;
/** Directories never worth scanning for main classes. */
const IGNORED_ENTRY_POINT_DIRS = new Set([
	'.git',
	'.gradle',
	'target',
	'build',
	'node_modules',
	'.idea',
]);

/**
 * True when a Java source declares a `public static void main` entry point.
 * Pure predicate so tests can exercise it without touching the filesystem.
 */
export function isMainClass(source: string): boolean {
	return /\bpublic\s+static\s+void\s+main\s*\(/.test(source);
}

/**
 * Bounded recursive scan for `.java` files containing a main method.
 * Returns repo-relative paths (relative to `dir`), in discovery order.
 */
function scanForMainClasses(dir: string): string[] {
	const results: string[] = [];
	const stack: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }];
	let visited = 0;
	let totalBytes = 0;
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current || current.depth > MAX_ENTRY_POINT_DEPTH) continue;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current.dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (visited >= MAX_ENTRY_POINT_FILES) return results;
			const full = path.join(current.dir, entry.name);
			if (entry.isDirectory()) {
				if (IGNORED_ENTRY_POINT_DIRS.has(entry.name)) continue;
				stack.push({ dir: full, depth: current.depth + 1 });
			} else if (entry.isFile() && entry.name.endsWith('.java')) {
				visited++;
				let size: number;
				try {
					size = fs.statSync(full).size;
				} catch {
					// unreadable file — skip
					continue;
				}
				// Per-file cap: skip oversized files rather than reading them.
				if (size > MAX_ENTRY_POINT_FILE_BYTES) continue;
				// Total-byte cap: stop the scan once cumulative bytes would
				// exceed the fixed maximum, bounding the synchronous init work.
				if (totalBytes + size > MAX_ENTRY_POINT_TOTAL_BYTES) return results;
				try {
					const source = fs.readFileSync(full, 'utf-8');
					totalBytes += size;
					if (isMainClass(source)) {
						results.push(path.relative(dir, full));
					}
				} catch {
					// unreadable file — skip
				}
			}
		}
	}
	return results;
}

/**
 * Detect a dominant Java web framework from pom.xml / build.gradle content.
 * Pure helper so tests can exercise the detector without a filesystem.
 */
export function detectFramework(content: string): FrameworkSelection | null {
	if (content.length === 0) return null;
	if (
		/\bspring-boot-starter-web\b|\bspring-boot\b|\bspring-web\b|\bspring-context\b/.test(
			content,
		)
	) {
		return { name: 'spring', detectedVia: 'spring-boot/spring dependency' };
	}
	if (/\bjakarta\.servlet\b|\bjavax\.servlet\b/.test(content)) {
		return { name: 'servlet', detectedVia: 'jakarta/javax servlet dependency' };
	}
	return null;
}

/**
 * Delegate import extraction to the shared Java module, mapping each parsed
 * import to its `.specifier` string. Dedupes via a Set while preserving order.
 */
function extractImports(_sourceFile: string, source: string): string[] {
	const seen = new Set<string>();
	for (const imp of parseJavaImports(source)) {
		seen.add(imp.specifier);
	}
	return [...seen];
}

/**
 * True when a wrapper file named `name` exists in `dir`. Uses `existsSync`
 * rather than a try/catch `accessSync` probe so callers avoid exception-based
 * control flow.
 */
function wrapperExists(dir: string, name: string): boolean {
	return fs.existsSync(path.join(dir, name));
}

/**
 * Resolve the Maven wrapper command name: Windows prefers `mvnw.cmd` when it
 * exists, otherwise the POSIX `./mvnw` script.
 */
function resolveMvnwCommand(dir: string): string {
	const isWindows = process.platform === 'win32';
	const hasMvnwCmd = wrapperExists(dir, 'mvnw.cmd');
	return isWindows && hasMvnwCmd ? 'mvnw.cmd' : './mvnw';
}

/**
 * Resolve the Gradle wrapper command name: Windows prefers `gradlew.bat` when
 * it exists, otherwise the POSIX `./gradlew` script. Mirrors
 * `resolveMvnwCommand` so the Gradle wrapper is Windows-aware symmetric to the
 * Maven wrapper.
 */
function resolveGradlewCommand(dir: string): string {
	const isWindows = process.platform === 'win32';
	const hasGradlewBat = wrapperExists(dir, 'gradlew.bat');
	return isWindows && hasGradlewBat ? 'gradlew.bat' : './gradlew';
}

/**
 * Prefer the Gradle wrapper when present, then the Maven wrapper; otherwise
 * defer to the default registry-driven selection (which checks binary
 * availability). Both wrapper checks are repo-local file probes, so they work
 * even when `gradle`/`mvn` are not resolvable on PATH. Gradle wins if both
 * wrappers exist (Gradle can wrap Maven repos too).
 */
async function selectTestFramework(
	dir: string,
): Promise<TestFrameworkSelection | null> {
	if (wrapperExists(dir, 'gradlew')) {
		return {
			name: 'gradle',
			cmd: [resolveGradlewCommand(dir), 'test', '-q'],
			cwd: dir,
			detectedVia: './gradlew',
			filesIgnored: false,
		};
	}
	if (wrapperExists(dir, 'mvnw')) {
		return {
			name: 'maven',
			cmd: [resolveMvnwCommand(dir), 'test', '-q'],
			cwd: dir,
			detectedVia: './mvnw',
			filesIgnored: false,
		};
	}
	const profile = LANGUAGE_REGISTRY.get(PROFILE_ID);
	if (!profile) return null;
	return defaultSelectTestFramework(profile, dir);
}

/**
 * Identify entry points: `.java` files declaring `public static void main`.
 */
async function selectEntryPoints(dir: string): Promise<string[]> {
	// Yield to the event loop before running the synchronous, potentially
	// slow scan, so a caller on a hot synchronous path is never blocked
	// within the same tick (defense in depth alongside the 2.3 size caps).
	await new Promise<void>((resolve) => setImmediate(resolve));
	return scanForMainClasses(dir);
}

/**
 * Detect the dominant Java web framework from build manifests.
 */
async function selectFramework(
	dir: string,
): Promise<FrameworkSelection | null> {
	let content = '';
	for (const file of ['pom.xml', 'build.gradle', 'build.gradle.kts']) {
		try {
			content += `\n${fs.readFileSync(path.join(dir, file), 'utf-8')}`;
		} catch {
			// manifest absent — skip
		}
	}
	return detectFramework(content);
}

/**
 * Build the Java backend from the registered profile.
 */
export function buildJavaBackend(): LanguageBackend {
	const profile = LANGUAGE_REGISTRY.get(PROFILE_ID);
	if (!profile) {
		throw new Error(
			'buildJavaBackend: java profile not in LANGUAGE_REGISTRY. ' +
				'profiles.ts must be imported before this backend.',
		);
	}
	return {
		...defaultBackendFor(profile),
		extractImports,
		selectTestFramework,
		selectEntryPoints,
		selectFramework,
	};
}

export const _internals: {
	extractImports: typeof extractImports;
	isMainClass: typeof isMainClass;
	detectFramework: typeof detectFramework;
	wrapperExists: typeof wrapperExists;
	resolveMvnwCommand: typeof resolveMvnwCommand;
	resolveGradlewCommand: typeof resolveGradlewCommand;
} = {
	extractImports,
	isMainClass,
	detectFramework,
	wrapperExists,
	resolveMvnwCommand,
	resolveGradlewCommand,
};
