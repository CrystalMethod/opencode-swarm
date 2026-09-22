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
				try {
					if (isMainClass(fs.readFileSync(full, 'utf-8'))) {
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
 * Prefer the Gradle wrapper when present, then the Maven wrapper; otherwise
 * defer to the default registry-driven selection (which checks binary
 * availability). Both wrapper checks are repo-local file probes, so they work
 * even when `gradle`/`mvn` are not resolvable on PATH. Gradle wins if both
 * wrappers exist (Gradle can wrap Maven repos too).
 */
async function selectTestFramework(
	dir: string,
): Promise<TestFrameworkSelection | null> {
	try {
		fs.accessSync(path.join(dir, 'gradlew'));
		return {
			name: 'gradle',
			cmd: ['./gradlew', 'test', '-q'],
			cwd: dir,
			detectedVia: './gradlew',
			filesIgnored: false,
		};
	} catch {
		// no gradle wrapper — try the Maven wrapper
	}
	try {
		fs.accessSync(path.join(dir, 'mvnw'));
		const isWindows = process.platform === 'win32';
		const hasMvnwCmd = fs.existsSync(path.join(dir, 'mvnw.cmd'));
		const mvnw = isWindows && hasMvnwCmd ? 'mvnw.cmd' : './mvnw';
		return {
			name: 'maven',
			cmd: [mvnw, 'test', '-q'],
			cwd: dir,
			detectedVia: './mvnw',
			filesIgnored: false,
		};
	} catch {
		// no wrapper — fall through to the default
	}
	const profile = LANGUAGE_REGISTRY.get(PROFILE_ID);
	if (!profile) return null;
	return defaultSelectTestFramework(profile, dir);
}

/**
 * Identify entry points: `.java` files declaring `public static void main`.
 */
async function selectEntryPoints(dir: string): Promise<string[]> {
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
} = { extractImports, isMainClass, detectFramework };
