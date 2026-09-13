import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validateProjectRoot } from '../evidence/manager.js';
import { _internals as goInternals } from '../lang/backends/go';
import { _internals as pythonInternals } from '../lang/backends/python';
import { atomicWriteSwarmFile } from '../utils/atomic-write.js';
import { IMPACT_CACHE_VERSION } from './constants';

/**
 * Impact analysis is advisory and must never turn a caller's request into an
 * unbounded workspace scan. These limits are deliberately larger than the
 * 50-file execution cap: a normal repository may have more test files than a
 * single invocation may safely execute, but a pathological repository must
 * still fail closed before it consumes unbounded memory or CPU.
 */
export const MAX_IMPACT_TEST_FILES = 4096;
export const MAX_IMPACT_TEST_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_IMPACT_SCAN_BYTES = 128 * 1024 * 1024;
export const MAX_IMPACT_WALK_ENTRIES = 100_000;
export const MAX_IMPACT_SCAN_DEPTH = 32;
export const MAX_IMPACT_CACHE_BYTES = 32 * 1024 * 1024;
export const MAX_IMPACT_MAP_SOURCES = 10_000;
export const MAX_IMPACT_MAP_REFERENCES = 100_000;

export interface TestImpactResult {
	impactedTests: string[];
	unrelatedTests: string[];
	untestedFiles: string[];
	impactMap: Record<string, string[]>;
	budgetExceeded?: boolean;
}

export type ImpactCacheStatus =
	| 'fresh'
	| 'missing'
	| 'corrupt'
	| 'legacy'
	| 'stale'
	| 'rebuilt_missing'
	| 'rebuilt_corrupt'
	| 'rebuilt_legacy'
	| 'rebuilt_stale'
	| 'overflow'
	| 'overflow_unverified'
	| 'missing_unverified'
	| 'corrupt_unverified'
	| 'legacy_unverified'
	| 'fresh_unverified';

export interface ImpactCacheInspection {
	status: ImpactCacheStatus;
	cachePath: string;
}

interface TestFileIdentity {
	path: string;
	size: number;
	mtimeMs: number;
	digest: string;
}

interface ImpactCacheEnvelope {
	version: number;
	generatedAt: string;
	fileCount: number;
	map: Record<string, string[]>;
	testFiles: TestFileIdentity[];
}

interface TestFileScanResult {
	files: string[];
	totalBytes: number;
	exceeded: boolean;
}

class ImpactScanLimitError extends Error {
	readonly code = 'IMPACT_SCAN_LIMIT';

	constructor() {
		super('impact analysis scan limits exceeded');
		this.name = 'ImpactScanLimitError';
	}
}

// TS/JS imports (multi-line aware). Keep side-effect and `from` imports
// separate so a side-effect import cannot consume a later declaration's
// `from` clause across a statement boundary.
const IMPORT_REGEX_ES_SIDE_EFFECT = /\bimport\s*['"]([^'"]+)['"]/g;
const IMPORT_REGEX_ES_FROM =
	/\bimport\s+(?:(?!\b(?:import|export)\b)[^;])*?\s+from\s+['"]([^'"]+)['"]/g;
const IMPORT_REGEX_REQUIRE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const IMPORT_REGEX_REEXPORT =
	/export\s+(?:\{[^}]*\}|\*)\s+from\s+['"]([^'"]+)['"]/g;

// Per-language extension sets. The impact analyzer walks tests of every
// supported language, then routes each file through the right backend's
// `extractImports` based on extension.
const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const PYTHON_EXTENSIONS = new Set(['.py']);
const GO_EXTENSIONS = new Set(['.go']);

const EXTENSIONS_TO_TRY = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

function normalizePath(p: string): string {
	return p.replace(/\\/g, '/');
}

// Rank helper: count matching directory/path segments from the tail.
function sharedTrailingSegments(a: string, b: string): number {
	const aParts = normalizePath(a).split('/').filter(Boolean);
	const bParts = normalizePath(b).split('/').filter(Boolean);
	let i = aParts.length - 1;
	let j = bParts.length - 1;
	let shared = 0;
	while (i >= 0 && j >= 0 && aParts[i] === bParts[j]) {
		shared++;
		i--;
		j--;
	}
	return shared;
}

function digestContent(content: string): string {
	return createHash('sha256').update(content).digest('hex');
}

function scanTestFilesSync(cwd: string): TestFileScanResult {
	const result: TestFileScanResult = {
		files: [],
		totalBytes: 0,
		exceeded: false,
	};
	const visitedRealPaths = new Set<string>();
	let visitedEntries = 0;

	function walk(dir: string, depth: number): void {
		if (result.exceeded) return;
		if (depth > MAX_IMPACT_SCAN_DEPTH) {
			result.exceeded = true;
			return;
		}

		let directory: fs.Dir;
		try {
			directory = fs.opendirSync(dir);
		} catch {
			return;
		}

		try {
			let realPath: string;
			try {
				realPath = normalizePath(fs.realpathSync.native(dir));
			} catch {
				return;
			}
			const directoryKey =
				process.platform === 'win32' ? realPath.toLowerCase() : realPath;
			if (visitedRealPaths.has(directoryKey)) return;
			visitedRealPaths.add(directoryKey);

			while (true) {
				const entry = directory.readSync();
				if (entry === null) break;
				if (++visitedEntries > MAX_IMPACT_WALK_ENTRIES) {
					result.exceeded = true;
					return;
				}
				if (entry.isDirectory()) {
					if (!SKIP_TEST_SCAN_DIRS.has(entry.name)) {
						walk(path.join(dir, entry.name), depth + 1);
					}
					if (result.exceeded) return;
					continue;
				}
				if (!entry.isFile()) continue;

				const name = entry.name;
				const isTsTest =
					/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(name) ||
					(dir.includes('__tests__') && /\.(ts|tsx|js|jsx)$/.test(name));
				const isPyTest =
					/^test_.+\.py$/.test(name) ||
					/.+_test\.py$/.test(name) ||
					(dir.includes(`${path.sep}tests${path.sep}`) && name.endsWith('.py'));
				const isGoTest = /.+_test\.go$/.test(name);
				if (!isTsTest && !isPyTest && !isGoTest) continue;

				let size: number;
				try {
					size = fs.statSync(path.join(dir, name)).size;
				} catch {
					continue;
				}
				if (
					size > MAX_IMPACT_TEST_FILE_BYTES ||
					result.files.length >= MAX_IMPACT_TEST_FILES ||
					result.totalBytes + size > MAX_IMPACT_SCAN_BYTES
				) {
					result.exceeded = true;
					return;
				}
				result.totalBytes += size;
				result.files.push(normalizePath(path.join(dir, name)));
			}
		} catch {
			// A directory can disappear or become unreadable during a bounded scan.
			// Preserve the fail-closed budget result without leaking the handle.
		} finally {
			try {
				directory.closeSync();
			} catch {
				// best effort cleanup when the directory was closed concurrently
			}
		}
	}

	walk(cwd, 0);
	return result;
}

const SKIP_TEST_SCAN_DIRS = new Set([
	'node_modules',
	'dist',
	'.git',
	'.swarm',
	'.cache',
]);

function getBoundedTestFiles(cwd: string): string[] {
	const scan = scanTestFilesSync(cwd);
	if (scan.exceeded) throw new ImpactScanLimitError();
	return scan.files;
}

function readBoundedTestFile(
	testFile: string,
	state: { totalBytes: number },
): string {
	let fd: number | undefined;
	try {
		fd = fs.openSync(testFile, 'r');
		const stat = fs.fstatSync(fd);
		const remainingBudget = MAX_IMPACT_SCAN_BYTES - state.totalBytes;
		const allowedBytes = Math.min(MAX_IMPACT_TEST_FILE_BYTES, remainingBudget);
		if (stat.size > allowedBytes) throw new ImpactScanLimitError();

		const chunks: Buffer[] = [];
		let totalBytes = 0;
		while (true) {
			const remaining = allowedBytes + 1 - totalBytes;
			if (remaining <= 0) throw new ImpactScanLimitError();
			const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
			const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, totalBytes);
			if (bytesRead === 0) break;
			totalBytes += bytesRead;
			if (totalBytes > allowedBytes) throw new ImpactScanLimitError();
			chunks.push(chunk.subarray(0, bytesRead));
		}
		state.totalBytes += totalBytes;
		return Buffer.concat(chunks, totalBytes).toString('utf8');
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

function buildTestFileManifest(
	cwd: string,
	testFiles?: string[],
): TestFileIdentity[] {
	const manifest: TestFileIdentity[] = [];
	const files = testFiles ?? getBoundedTestFiles(cwd);
	if (files.length > MAX_IMPACT_TEST_FILES) throw new ImpactScanLimitError();
	const state = { totalBytes: 0 };
	for (const testFile of files.sort()) {
		try {
			const stat = fs.statSync(testFile);
			const content = readBoundedTestFile(testFile, state);
			manifest.push({
				path: normalizePath(testFile),
				size: stat.size,
				mtimeMs: stat.mtimeMs,
				digest: digestContent(content),
			});
		} catch (error) {
			// A concurrently deleted or unreadable test file makes the identity
			// unverifiable; the next load will rebuild safely.
			if (error instanceof ImpactScanLimitError) throw error;
		}
	}
	return manifest;
}

function testManifestChanged(cached: TestFileIdentity[], cwd: string): boolean {
	if (cached.length > MAX_IMPACT_TEST_FILES) throw new ImpactScanLimitError();
	const scan = scanTestFilesSync(cwd);
	if (scan.exceeded) throw new ImpactScanLimitError();
	const currentFiles = scan.files.map(normalizePath).sort();
	const cachedFiles = cached.map((entry) => normalizePath(entry.path)).sort();
	if (
		currentFiles.length !== cachedFiles.length ||
		currentFiles.some((file, index) => file !== cachedFiles[index])
	)
		return true;

	const cachedByPath = new Map(
		cached.map((entry) => [normalizePath(entry.path), entry]),
	);
	const state = { totalBytes: 0 };
	for (const file of currentFiles) {
		const previous = cachedByPath.get(file);
		if (!previous) return true;
		try {
			const content = readBoundedTestFile(file, state);
			const stat = fs.statSync(file);
			if (
				stat.size !== previous.size ||
				stat.mtimeMs !== previous.mtimeMs ||
				digestContent(content) !== previous.digest
			)
				return true;
		} catch (error) {
			if (error instanceof ImpactScanLimitError) throw error;
			return true;
		}
	}
	return false;
}

function isCacheStale(
	impactMap: Record<string, string[]>,
	generatedAtMs: number,
	testFiles?: TestFileIdentity[],
	cwd?: string,
): boolean {
	if (testFiles && cwd && testManifestChanged(testFiles, cwd)) return true;
	let sourceCount = 0;
	for (const sourcePath in impactMap) {
		if (!Object.hasOwn(impactMap, sourcePath)) continue;
		if (++sourceCount > MAX_IMPACT_MAP_SOURCES)
			throw new ImpactScanLimitError();
		try {
			const stat = fs.statSync(sourcePath);
			if (stat.mtimeMs > generatedAtMs) {
				return true; // Source file is newer than cache
			}
		} catch {
			// Source file deleted — cache is stale
			return true;
		}
	}
	return false;
}

function resolveRelativeImport(
	fromDir: string,
	importPath: string,
): string | null {
	if (!importPath.startsWith('.')) {
		return null;
	}

	const resolved = path.resolve(fromDir, importPath);

	// If the import already has an extension, try as-is first
	if (path.extname(resolved)) {
		if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
			return normalizePath(resolved);
		}
	} else {
		// Try adding extensions
		for (const ext of EXTENSIONS_TO_TRY) {
			const withExt = resolved + ext;
			if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
				return normalizePath(withExt);
			}
		}
	}

	return null;
}

/**
 * Resolve a Python relative import (`from . import x` / `.foo` / `..bar.baz`)
 * to an absolute file path. Non-relative imports return null — they would
 * require sys.path / pyproject resolution that the analyzer does not perform.
 *
 * `module` is the captured dotted name from the `from` clause; values like
 * `.foo`, `..bar.baz`, or `.` (current package).
 */
function resolvePythonImport(fromDir: string, module: string): string | null {
	if (!module.startsWith('.')) return null;
	// Count leading dots — each one walks one directory up.
	const leadingDots = module.match(/^\.+/)?.[0].length ?? 0;
	let baseDir = fromDir;
	for (let i = 1; i < leadingDots; i++) {
		baseDir = path.dirname(baseDir);
	}
	const rest = module.slice(leadingDots);
	if (rest.length === 0) {
		// `from . import x` — caller passes module="."; the actual file is
		// __init__.py in baseDir.
		const initPath = path.join(baseDir, '__init__.py');
		if (fs.existsSync(initPath) && fs.statSync(initPath).isFile()) {
			return normalizePath(initPath);
		}
		return null;
	}
	const subpath = rest.replace(/\./g, path.sep);
	const candidates = [
		`${path.join(baseDir, subpath)}.py`,
		path.join(baseDir, subpath, '__init__.py'),
	];
	for (const c of candidates) {
		if (fs.existsSync(c) && fs.statSync(c).isFile()) return normalizePath(c);
	}
	return null;
}

/**
 * Find the `module <path>` line in the nearest go.mod walking up from
 * `fromDir`. Returns `{ moduleRoot, modulePath }` or null when no go.mod
 * is found. Bounded by a 16-level upward walk so an analyzer invocation
 * cannot walk past the filesystem root on pathological inputs.
 *
 * Result is memoized per moduleRoot for the lifetime of an analyzer pass
 * (callers within `buildImpactMapInternal` re-resolve frequently).
 */
const goModuleCache = new Map<
	string,
	{ moduleRoot: string; modulePath: string } | null
>();
function findGoModule(
	fromDir: string,
): { moduleRoot: string; modulePath: string } | null {
	const resolved = path.resolve(fromDir);
	let cur = resolved;
	const walked: string[] = [];
	for (let i = 0; i < 16; i++) {
		const cached = goModuleCache.get(cur);
		if (cached !== undefined) {
			// Backfill walked dirs with this result for O(1) repeat lookups.
			for (const d of walked) goModuleCache.set(d, cached);
			return cached;
		}
		walked.push(cur);
		try {
			const goMod = path.join(cur, 'go.mod');
			const content = fs.readFileSync(goMod, 'utf-8');
			// Strip optional surrounding quotes and trailing `// comment`.
			// Both forms are valid: `module example.com/x` and
			// `module "example.com/x" // some note`. Without the strip the
			// modulePath captured ends up as `"example.com/x"` and never
			// matches imports.
			const moduleMatch = content.match(
				/^\s*module\s+"?([^"\s/]+(?:\/[^"\s]+)*)"?/m,
			);
			if (moduleMatch) {
				const result = { moduleRoot: cur, modulePath: moduleMatch[1] };
				for (const d of walked) goModuleCache.set(d, result);
				return result;
			}
		} catch {
			// no go.mod here — walk up
		}
		// Stop at .git boundary (project root). Prevents leaking past the
		// project into /tmp/go.mod or /home/user/go.mod from other tests.
		// Adversarial review D1.
		try {
			fs.accessSync(path.join(cur, '.git'));
			break;
		} catch {
			// no .git here, continue walking
		}
		const parent = path.dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	for (const d of walked) goModuleCache.set(d, null);
	return null;
}

/**
 * Resolve a Go import to local source files. Handles three cases:
 *
 *   1. Relative: `./pkg/foo` or `../pkg/foo` — resolved against fromDir.
 *   2. Module path: `github.com/myorg/myrepo/pkg/foo` — when the import
 *      starts with the local module path declared in go.mod, the remainder
 *      maps to a directory under the module root. PR #825 review P1 #4
 *      flagged that this resolution was missing; module imports are the
 *      DOMINANT form in real Go projects.
 *   3. Stdlib / external (no slash, or unrecognized prefix): returns [].
 *
 * In all matching cases, walks the target directory and returns ALL .go
 * files (excluding *_test.go), treating the package as a unit.
 */
function resolveGoImport(fromDir: string, importPath: string): string[] {
	let dir: string | null = null;

	if (importPath.startsWith('.')) {
		dir = path.resolve(fromDir, importPath);
	} else {
		const mod = findGoModule(fromDir);
		if (
			mod &&
			(importPath === mod.modulePath ||
				importPath.startsWith(`${mod.modulePath}/`))
		) {
			const subpath = importPath.slice(mod.modulePath.length);
			dir = path.join(mod.moduleRoot, subpath);
		}
	}

	if (dir === null) return [];
	if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
	let directory: fs.Dir | undefined;
	try {
		directory = fs.opendirSync(dir);
		const files: string[] = [];
		let entries = 0;
		while (true) {
			const entry = directory.readSync();
			if (entry === null) break;
			if (++entries > MAX_IMPACT_WALK_ENTRIES) return [];
			if (
				entry.isFile() &&
				entry.name.endsWith('.go') &&
				!entry.name.endsWith('_test.go')
			) {
				files.push(normalizePath(path.join(dir, entry.name)));
			}
		}
		return files;
	} catch {
		return [];
	} finally {
		directory?.closeSync();
	}
}

/**
 * Test-only: clear the go-module memoization cache. Production code
 * should never need this — the cache is per-call-graph scoped, but tests
 * that reuse the same tempDir benefit from a fresh start.
 */
function _clearGoModuleCache(): void {
	goModuleCache.clear();
}

function findTestFilesSync(cwd: string): string[] {
	return scanTestFilesSync(cwd).files;
}

function extractImports(content: string): string[] {
	function execRegex(regex: RegExp, content: string): string[] {
		const results: string[] = [];
		regex.lastIndex = 0;
		let match: RegExpExecArray | null;
		// biome-ignore lint/suspicious/noAssignInExpressions: regex exec requires assignment in while condition
		while ((match = regex.exec(content)) !== null) {
			results.push(match[1]);
		}
		return results;
	}

	return [
		...execRegex(IMPORT_REGEX_ES_SIDE_EFFECT, content),
		...execRegex(IMPORT_REGEX_ES_FROM, content),
		...execRegex(IMPORT_REGEX_REQUIRE, content),
		...execRegex(IMPORT_REGEX_REEXPORT, content),
	];
}

/**
 * Per-file impact contribution. Inspects the test file's extension, picks
 * the right import-extraction regex (TS via legacy regex, Python via
 * `lang/backends/python._internals.extractImports`, Go via
 * `lang/backends/go._internals.extractImports`), resolves each import to a
 * source-file path via the matching language-specific resolver, and
 * appends the test file to that source's impact list.
 *
 * Why route through the backend `_internals` rather than `pickBackend`?
 * The impact analyzer runs on individual files inside a workspace; the
 * dispatch resolver picks ONE backend per directory tree. For
 * cross-language repos (e.g. a Go service with a TS web client) we need
 * file-level routing, which the file extension already gives us.
 */
function addImpactEdgesForTestFile(
	testFile: string,
	content: string,
	impactMap: Record<string, string[]>,
): void {
	const ext = path.extname(testFile).toLowerCase();
	const testDir = path.dirname(testFile);

	function addEdge(source: string): void {
		if (!impactMap[source]) impactMap[source] = [];
		if (!impactMap[source].includes(testFile)) {
			impactMap[source].push(testFile);
		}
	}

	if (TS_EXTENSIONS.has(ext)) {
		const imports = extractImports(content);
		for (const importPath of imports) {
			const resolved = resolveRelativeImport(testDir, importPath);
			if (resolved !== null) addEdge(resolved);
		}
		return;
	}

	if (PYTHON_EXTENSIONS.has(ext)) {
		const modules = pythonInternals.extractImports(testFile, content);
		for (const mod of modules) {
			const resolved = resolvePythonImport(testDir, mod);
			if (resolved !== null) addEdge(resolved);
		}
		return;
	}

	if (GO_EXTENSIONS.has(ext)) {
		const imports = goInternals.extractImports(testFile, content);
		for (const importPath of imports) {
			const sourceFiles = resolveGoImport(testDir, importPath);
			for (const source of sourceFiles) addEdge(source);
		}
		return;
	}

	// Unknown extension — no-op. The walker shouldn't surface these, but
	// staying defensive keeps the analyzer stable when new test file types
	// land in the walker before this dispatch is updated.
}

async function buildImpactMapInternal(
	cwd: string,
	testFilesOverride?: string[],
): Promise<Record<string, string[]>> {
	_clearGoModuleCache();
	const testFiles = testFilesOverride ?? getBoundedTestFiles(cwd);
	if (testFiles.length > MAX_IMPACT_TEST_FILES)
		throw new ImpactScanLimitError();
	const impactMap: Record<string, string[]> = {};
	const state = { totalBytes: 0 };

	for (const testFile of testFiles) {
		let content: string;
		try {
			content = readBoundedTestFile(testFile, state);
		} catch (error) {
			// Skip files that can't be read
			if (error instanceof ImpactScanLimitError) throw error;
			continue;
		}

		// Skip binary files (null bytes in first 8KB)
		if (content.substring(0, 8192).includes('\0')) {
			continue;
		}

		addImpactEdgesForTestFile(testFile, content, impactMap);
	}

	return impactMap;
}

function validateImpactMap(value: unknown): 'valid' | 'invalid' | 'overflow' {
	if (value === null || typeof value !== 'object' || Array.isArray(value))
		return 'invalid';
	let sourceCount = 0;
	let referenceCount = 0;
	for (const sourcePath in value as Record<string, unknown>) {
		if (!Object.hasOwn(value, sourcePath)) continue;
		if (++sourceCount > MAX_IMPACT_MAP_SOURCES) return 'overflow';
		const tests = (value as Record<string, unknown>)[sourcePath];
		if (!Array.isArray(tests)) return 'invalid';
		for (const test of tests) {
			if (++referenceCount > MAX_IMPACT_MAP_REFERENCES) return 'overflow';
			if (typeof test !== 'string') return 'invalid';
		}
	}
	return 'valid';
}

function unverifiedStatus(status: ImpactCacheStatus): ImpactCacheStatus {
	if (status === 'fresh' || status === 'stale') return 'fresh_unverified';
	if (status === 'missing') return 'missing_unverified';
	if (status === 'corrupt') return 'corrupt_unverified';
	if (status === 'legacy') return 'legacy_unverified';
	if (status === 'overflow') return 'overflow_unverified';
	return status;
}

type BoundedCacheRead =
	| { status: 'ok'; text: string }
	| { status: 'missing' | 'overflow' | 'unstable' | 'unavailable' };

/**
 * Read one cache generation through an open descriptor and a hard byte cap.
 * The descriptor keeps an atomic replacement from redirecting the read, while
 * the final stat rejects a file that grew or was truncated during the read.
 */
function readBoundedCacheText(filePath: string): BoundedCacheRead {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, 'r');
		const initial = fs.fstatSync(fd);
		if (initial.size > MAX_IMPACT_CACHE_BYTES) return { status: 'overflow' };

		const chunks: Buffer[] = [];
		const chunk = Buffer.allocUnsafe(64 * 1024);
		let totalBytes = 0;
		while (totalBytes <= MAX_IMPACT_CACHE_BYTES) {
			const bytesToRead = Math.min(
				chunk.length,
				MAX_IMPACT_CACHE_BYTES + 1 - totalBytes,
			);
			const bytesRead = fs.readSync(fd, chunk, 0, bytesToRead, totalBytes);
			if (bytesRead === 0) break;
			chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
			totalBytes += bytesRead;
			if (totalBytes > MAX_IMPACT_CACHE_BYTES) return { status: 'overflow' };
		}

		const final = fs.fstatSync(fd);
		if (
			final.size > MAX_IMPACT_CACHE_BYTES ||
			totalBytes > MAX_IMPACT_CACHE_BYTES
		) {
			return { status: 'overflow' };
		}
		if (
			final.size !== totalBytes ||
			final.dev !== initial.dev ||
			final.ino !== initial.ino
		) {
			return { status: 'unstable' };
		}
		return {
			status: 'ok',
			text: Buffer.concat(chunks, totalBytes).toString('utf8'),
		};
	} catch (error) {
		return {
			status:
				(error as NodeJS.ErrnoException).code === 'ENOENT'
					? 'missing'
					: 'unavailable',
		};
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

function readImpactCache(
	cwd: string,
	verify = true,
): {
	envelope: ImpactCacheEnvelope | null;
	status: ImpactCacheStatus;
} {
	const cachePath = path.join(cwd, '.swarm', 'cache', 'impact-map.json');
	const boundedRead = readBoundedCacheText(cachePath);
	if (boundedRead.status === 'missing') {
		return {
			envelope: null,
			status: verify ? 'missing' : 'missing_unverified',
		};
	}
	if (boundedRead.status === 'overflow') {
		return {
			envelope: null,
			status: verify ? 'overflow' : 'overflow_unverified',
		};
	}
	if (boundedRead.status !== 'ok') {
		return {
			envelope: null,
			status: verify ? 'corrupt' : 'corrupt_unverified',
		};
	}
	try {
		const data = JSON.parse(boundedRead.text) as Partial<ImpactCacheEnvelope>;
		const mapStatus = validateImpactMap(data.map);
		if (
			data.version !== IMPACT_CACHE_VERSION ||
			typeof data.generatedAt !== 'string' ||
			mapStatus !== 'valid' ||
			typeof data.fileCount !== 'number' ||
			!Array.isArray(data.testFiles) ||
			data.testFiles.length > MAX_IMPACT_TEST_FILES ||
			!data.testFiles.every(
				(entry) =>
					typeof entry === 'object' &&
					entry !== null &&
					typeof entry.path === 'string' &&
					typeof entry.size === 'number' &&
					typeof entry.mtimeMs === 'number' &&
					typeof entry.digest === 'string',
			)
		) {
			if (
				mapStatus === 'overflow' ||
				(Array.isArray(data.testFiles) &&
					data.testFiles.length > MAX_IMPACT_TEST_FILES)
			) {
				return {
					envelope: null,
					status: verify ? 'overflow' : 'overflow_unverified',
				};
			}
			const status: ImpactCacheStatus =
				data.map !== undefined &&
				(data.version === undefined ||
					(typeof data.version === 'number' &&
						data.version < IMPACT_CACHE_VERSION))
					? 'legacy'
					: 'corrupt';
			return {
				envelope: null,
				status: verify ? status : unverifiedStatus(status),
			};
		}
		const envelope = data as ImpactCacheEnvelope;
		const generatedAtMs = new Date(envelope.generatedAt).getTime();
		if (!Number.isFinite(generatedAtMs)) {
			return {
				envelope: null,
				status: verify ? 'corrupt' : 'corrupt_unverified',
			};
		}
		if (!verify) {
			return { envelope, status: 'fresh_unverified' };
		}
		try {
			if (
				_internals.isCacheStale(
					envelope.map,
					generatedAtMs,
					envelope.testFiles,
					cwd,
				)
			) {
				return { envelope, status: 'stale' };
			}
		} catch (error) {
			if (error instanceof ImpactScanLimitError) {
				return { envelope: null, status: 'overflow' };
			}
			throw error;
		}
		return { envelope, status: 'fresh' };
	} catch (error) {
		if (error instanceof ImpactScanLimitError) {
			return {
				envelope: null,
				status: verify ? 'overflow' : 'overflow_unverified',
			};
		}
		return {
			envelope: null,
			status: verify ? 'corrupt' : 'corrupt_unverified',
		};
	}
}

export function getImpactCacheStatus(
	cwd: string,
	options?: { verify?: boolean },
): ImpactCacheInspection {
	const cachePath = path.join(cwd, '.swarm', 'cache', 'impact-map.json');
	return {
		status: readImpactCache(cwd, options?.verify ?? true).status,
		cachePath,
	};
}

export const _internals: {
	validateProjectRoot: typeof validateProjectRoot;
	normalizePath: typeof normalizePath;
	isCacheStale: typeof isCacheStale;
	resolveRelativeImport: typeof resolveRelativeImport;
	findTestFilesSync: typeof findTestFilesSync;
	extractImports: typeof extractImports;
	buildImpactMapInternal: typeof buildImpactMapInternal;
	buildImpactMap: typeof buildImpactMap;
	loadImpactMap: typeof loadImpactMap;
	loadImpactMapWithStatus: typeof loadImpactMapWithStatus;
	saveImpactMap: typeof saveImpactMap;
	analyzeImpact: typeof analyzeImpact;
	getImpactCacheStatus: typeof getImpactCacheStatus;
	_clearGoModuleCache: typeof _clearGoModuleCache;
} = {
	validateProjectRoot,
	normalizePath,
	isCacheStale,
	resolveRelativeImport,
	findTestFilesSync,
	extractImports,
	buildImpactMapInternal,
	buildImpactMap,
	loadImpactMap,
	loadImpactMapWithStatus,
	saveImpactMap,
	analyzeImpact,
	getImpactCacheStatus,
	_clearGoModuleCache,
} as const;

export async function buildImpactMap(
	cwd: string,
): Promise<Record<string, string[]>> {
	const testFiles = getBoundedTestFiles(cwd);
	const impactMap = await _internals.buildImpactMapInternal(cwd, testFiles);
	await _internals.saveImpactMap(cwd, impactMap, testFiles);
	return impactMap;
}

export interface LoadImpactMapOptions {
	/** If true and cache is stale, return the stale map instead of rebuilding.
	 *  Use for estimation-only reads where slight staleness is acceptable. */
	skipRebuild?: boolean;
}

export interface ImpactMapLoadResult {
	map: Record<string, string[]>;
	status: ImpactCacheStatus;
}

function rebuiltCacheStatus(status: ImpactCacheStatus): ImpactCacheStatus {
	if (
		status === 'missing' ||
		status === 'corrupt' ||
		status === 'legacy' ||
		status === 'stale'
	)
		return `rebuilt_${status}` as ImpactCacheStatus;
	return status;
}

export async function loadImpactMapWithStatus(
	cwd: string,
	options?: LoadImpactMapOptions,
): Promise<ImpactMapLoadResult> {
	const inspection = readImpactCache(cwd, !options?.skipRebuild);
	if (inspection.envelope) {
		if (inspection.status === 'fresh' || options?.skipRebuild) {
			return { map: inspection.envelope.map, status: inspection.status };
		}
	}

	if (options?.skipRebuild) {
		return { map: {}, status: inspection.status };
	}
	try {
		return {
			map: await _internals.buildImpactMap(cwd),
			status: rebuiltCacheStatus(inspection.status),
		};
	} catch (error) {
		if (error instanceof ImpactScanLimitError) {
			return { map: {}, status: 'overflow' };
		}
		throw error;
	}
}

export async function loadImpactMap(
	cwd: string,
	options?: LoadImpactMapOptions,
): Promise<Record<string, string[]>> {
	return (await loadImpactMapWithStatus(cwd, options)).map;
}

async function saveImpactMap(
	cwd: string,
	impactMap: Record<string, string[]>,
	testFiles?: string[],
): Promise<void> {
	// Guard: reject if cwd is not an absolute path
	if (!path.isAbsolute(cwd)) {
		throw new Error(
			`saveImpactMap requires an absolute project root path, got: "${cwd}"`,
		);
	}
	const mapStatus = validateImpactMap(impactMap);
	if (mapStatus !== 'valid') {
		throw new Error(
			mapStatus === 'overflow'
				? 'saveImpactMap impact map exceeds bounded source/reference limits'
				: 'saveImpactMap received an invalid impact map',
		);
	}

	// Guard: reject writes to subdirectories of projects that already have .swarm/
	_internals.validateProjectRoot(cwd);

	const cacheDir = path.join(cwd, '.swarm', 'cache');
	const cachePath = path.join(cacheDir, 'impact-map.json');

	// Create directory if it doesn't exist
	if (!fs.existsSync(cacheDir)) {
		fs.mkdirSync(cacheDir, { recursive: true });
	}

	const data: ImpactCacheEnvelope = {
		version: IMPACT_CACHE_VERSION,
		generatedAt: new Date().toISOString(),
		fileCount: Object.keys(impactMap).length,
		map: impactMap,
		testFiles: buildTestFileManifest(cwd, testFiles),
	};

	await atomicWriteSwarmFile(cachePath, JSON.stringify(data, null, 2));
}

export async function analyzeImpact(
	changedFiles: string[],
	cwd: string,
	budget?: number,
	impactMapOverride?: Record<string, string[]>,
): Promise<TestImpactResult> {
	// Validate input
	if (!Array.isArray(changedFiles)) {
		const emptyMap: Record<string, string[]> = {};
		return {
			impactedTests: [],
			unrelatedTests: [],
			untestedFiles: [],
			impactMap: emptyMap,
		};
	}

	// Filter to valid string entries only
	const validFiles = changedFiles.filter(
		(f): f is string =>
			typeof f === 'string' && f.length > 0 && !f.includes('\0'),
	);

	const impactMap = impactMapOverride ?? (await _internals.loadImpactMap(cwd));

	const impactedTestsSet = new Set<string>();
	const impactedTestKeys = new Set<string>();
	const untestedFiles: string[] = [];
	let budgetExceeded = false;
	let traversedReferences = 0;
	let traversedSources = 0;

	const testKey = (test: string): string => {
		const resolved = path.isAbsolute(test) ? test : path.resolve(cwd, test);
		const normalized = normalizePath(resolved);
		return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
	};
	const addImpactedTest = (test: string): boolean => {
		if (++traversedReferences > MAX_IMPACT_MAP_REFERENCES) {
			budgetExceeded = true;
			return false;
		}
		const key = testKey(test);
		if (impactedTestKeys.has(key)) return true;
		if (budget !== undefined && impactedTestKeys.size >= budget) {
			budgetExceeded = true;
			return false;
		}
		impactedTestKeys.add(key);
		impactedTestsSet.add(test);
		return true;
	};

	for (const changedFile of validFiles) {
		const normalizedChanged = normalizePath(path.resolve(cwd, changedFile));

		const tests = impactMap[normalizedChanged];
		if (tests && tests.length > 0) {
			for (const test of tests) {
				addImpactedTest(test);
				if (budgetExceeded) break;
			}
			if (budgetExceeded) break;
		} else {
			// Check with different path variations
			const changedDir = normalizePath(path.dirname(normalizedChanged));
			const changedInputDir = normalizePath(path.dirname(changedFile));
			const suffixMatches: Array<[string, string[]]> = [];
			for (const sourcePath in impactMap) {
				if (!Object.hasOwn(impactMap, sourcePath)) continue;
				if (++traversedSources > MAX_IMPACT_MAP_SOURCES) {
					budgetExceeded = true;
					break;
				}
				const tests = impactMap[sourcePath];
				if (!Array.isArray(tests)) continue;
				if (
					sourcePath.endsWith(changedFile) ||
					changedFile.endsWith(sourcePath) ||
					sourcePath.endsWith(normalizedChanged) ||
					normalizedChanged.endsWith(sourcePath)
				)
					suffixMatches.push([sourcePath, tests]);
			}
			if (budgetExceeded) break;
			suffixMatches.sort(([sourceA], [sourceB]) => {
				const sourceDirA = normalizePath(path.dirname(sourceA));
				const sourceDirB = normalizePath(path.dirname(sourceB));
				const exactA =
					sourceDirA === changedDir ||
					(changedInputDir !== '.' &&
						(sourceDirA === changedInputDir ||
							sourceDirA.endsWith(`/${changedInputDir}`)));
				const exactB =
					sourceDirB === changedDir ||
					(changedInputDir !== '.' &&
						(sourceDirB === changedInputDir ||
							sourceDirB.endsWith(`/${changedInputDir}`)));
				if (exactA !== exactB) return exactA ? -1 : 1;

				const sharedA = Math.max(
					sharedTrailingSegments(sourceDirA, changedDir),
					changedInputDir === '.'
						? 0
						: sharedTrailingSegments(sourceDirA, changedInputDir),
				);
				const sharedB = Math.max(
					sharedTrailingSegments(sourceDirB, changedDir),
					changedInputDir === '.'
						? 0
						: sharedTrailingSegments(sourceDirB, changedInputDir),
				);
				const nearestA = sharedA > 0;
				const nearestB = sharedB > 0;
				if (nearestA !== nearestB) return nearestA ? -1 : 1;
				if (sharedA !== sharedB) return sharedB - sharedA;
				return sourceA.localeCompare(sourceB);
			});
			// A file is "found" if any suffix-matching map entry exists, regardless of
			// whether budget allows all its tests to be collected.
			const found = suffixMatches.length > 0;
			for (const [, tests] of suffixMatches) {
				for (const test of tests) {
					addImpactedTest(test);
					if (budgetExceeded) break;
				}
				if (budgetExceeded) break;
			}
			if (budgetExceeded) break;
			if (!found) {
				untestedFiles.push(changedFile);
			}
		}
	}

	const impactedTests = [...impactedTestsSet];

	// Compute unrelated tests (all tests in impact map minus impacted tests)
	const allTestFiles = new Map<string, string>();
	for (const sourcePath in impactMap) {
		if (budgetExceeded) break;
		if (!Object.hasOwn(impactMap, sourcePath)) continue;
		if (++traversedSources > MAX_IMPACT_MAP_SOURCES) {
			budgetExceeded = true;
			break;
		}
		const tests = impactMap[sourcePath];
		if (!Array.isArray(tests)) continue;
		for (const test of tests) {
			if (++traversedReferences > MAX_IMPACT_MAP_REFERENCES) {
				budgetExceeded = true;
				break;
			}
			if (typeof test !== 'string') continue;
			const key = testKey(test);
			if (!allTestFiles.has(key)) allTestFiles.set(key, test);
		}
	}
	const unrelatedTests = [...allTestFiles.entries()]
		.filter(([key]) => !impactedTestKeys.has(key))
		.map(([, test]) => test);

	return {
		impactedTests,
		unrelatedTests,
		untestedFiles,
		impactMap,
		budgetExceeded,
	};
}
