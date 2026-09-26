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
import { maskCommentsAndLiterals, parseJavaImports } from '../java-extraction';
import { LANGUAGE_REGISTRY } from '../profiles';

const PROFILE_ID = 'java';

/** Bounds for the entry-point tree scan — no unbounded recursion. */
const MAX_ENTRY_POINT_DEPTH = 8;
/**
 * Total directory-entry budget for the scan: every directory and file the
 * walk visits counts against this, not just `.java` files. A tree with many
 * subdirectories or non-Java files (an IDE output directory, a `.venv`
 * alongside the Java sources, etc.) costs real synchronous time even when it
 * contains zero `.java` files, so the cap must bound breadth, not just the
 * number of Java files found.
 */
const MAX_ENTRY_POINT_ENTRIES = 5000;
/**
 * Per-file size cap for the entry-point scan. A single oversized `.java` file
 * is skipped rather than read in full, keeping the synchronous init-path scan
 * bounded (a few hundred KB is far beyond any realistic main-class source).
 */
const MAX_ENTRY_POINT_FILE_BYTES = 256 * 1024;
/**
 * Total-byte cap across all `.java` files read during the entry-point scan.
 * The scan stops once cumulative bytes read would exceed this. Note this
 * bounds *file-read* cost only — see `MAX_ENTRY_POINT_ENTRIES` for the
 * directory-walk breadth bound, which this cap alone does not provide.
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
	'out',
	'bin',
	'.venv',
	'venv',
	'dist',
]);
/**
 * Test-source directories, walked last (deprioritized) relative to sibling
 * directories at the same level. A real `public static void main` almost
 * always lives under `src/main/...`, never under a test tree; walking test
 * directories first can otherwise exhaust `MAX_ENTRY_POINT_TOTAL_BYTES` on
 * test sources before the real entry point is ever reached (readdir order on
 * some filesystems visits `test` before `main`).
 */
const DEFERRED_ENTRY_POINT_DIRS = new Set([
	'test',
	'tests',
	'androidTest',
	'integrationTest',
	'testFixtures',
]);

/**
 * True when a Java source declares a `public static void main` entry point.
 * Pure predicate so tests can exercise it without touching the filesystem.
 */
export function isMainClass(source: string): boolean {
	// Masked so a commented-out or documentation-example `main` method is
	// never mistaken for a real entry point; modifier order is
	// order-agnostic (`static public void main` is valid Java, just unusual
	// style).
	const masked = maskCommentsAndLiterals(source);
	return /\b(?:public\s+static|static\s+public)\s+void\s+main\s*\(/.test(
		masked,
	);
}

/**
 * Bounded recursive scan for `.java` files containing a main method.
 * Returns repo-relative paths (relative to `dir`), in discovery order.
 */
function scanForMainClasses(dir: string): string[] {
	const results: string[] = [];
	const stack: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }];
	let entriesVisited = 0;
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
		// Push deferred (test-source) directories first and preferred
		// directories last, so the LIFO stack pops preferred directories
		// before deferred ones — a real main class is far more likely under
		// `src/main` than `src/test`, and this avoids the total-byte cap
		// being exhausted on test sources before `src/main` is ever reached.
		const deferredDirs: string[] = [];
		const preferredDirs: string[] = [];
		for (const entry of entries) {
			entriesVisited++;
			if (entriesVisited > MAX_ENTRY_POINT_ENTRIES) return results;
			const full = path.join(current.dir, entry.name);
			if (entry.isDirectory()) {
				if (IGNORED_ENTRY_POINT_DIRS.has(entry.name)) continue;
				if (DEFERRED_ENTRY_POINT_DIRS.has(entry.name)) {
					deferredDirs.push(full);
				} else {
					preferredDirs.push(full);
				}
			} else if (entry.isFile() && entry.name.endsWith('.java')) {
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
		for (const d of deferredDirs)
			stack.push({ dir: d, depth: current.depth + 1 });
		for (const d of preferredDirs)
			stack.push({ dir: d, depth: current.depth + 1 });
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
	// Yield to the event loop once before running the scan, so any work
	// already queued for this tick gets a chance to run first. This does
	// NOT let a timeout/AbortSignal preempt the scan itself — once
	// `scanForMainClasses` starts, it runs to completion synchronously; a
	// timer callback cannot fire mid-loop. The real bound on the scan's
	// cost is `MAX_ENTRY_POINT_ENTRIES` / the byte caps inside
	// `scanForMainClasses`, not this yield.
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
	MAX_ENTRY_POINT_ENTRIES: typeof MAX_ENTRY_POINT_ENTRIES;
} = {
	extractImports,
	isMainClass,
	detectFramework,
	wrapperExists,
	resolveMvnwCommand,
	resolveGradlewCommand,
	MAX_ENTRY_POINT_ENTRIES,
};
