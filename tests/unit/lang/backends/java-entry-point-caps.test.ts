import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	buildJavaBackend,
} from '../../../../src/lang/backends/java';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

describe('selectEntryPoints size caps', () => {
	const backend = buildJavaBackend();
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = canonicalMkdtemp('java-backend-ep-caps-');
	});

	afterEach(() => {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	test('skips .java files larger than the per-file size cap', async () => {
		// Big.java (300KB) exceeds the per-file cap (256KB) and must be skipped
		// rather than read in full, while the small main-class file is still
		// discovered. Without the per-file cap Big.java would be returned.
		const bigContent =
			'public class Big { public static void main(String[] args) {} }\n'.padEnd(
				300 * 1024,
				' ',
			);
		fs.writeFileSync(path.join(tmpDir, 'Big.java'), bigContent);
		fs.writeFileSync(
			path.join(tmpDir, 'Small.java'),
			'public class Small { public static void main(String[] args) {} }\n',
		);
		const eps = await backend.selectEntryPoints!(tmpDir);
		expect(eps).toEqual([path.join('Small.java')]);
	});

	test('stops scanning once the total-byte cap is exceeded', async () => {
		// 100 files × 10KB ≈ 1MB total, far above the 512KB total-byte cap, so
		// the scan must stop early instead of reading every file. Every file is
		// a main class and identical in size, so the bounded read count is
		// deterministic regardless of readdir order.
		const fileSize = 10 * 1024;
		const totalFiles = 100;
		const content =
			'public class F { public static void main(String[] args) {} }\n'.padEnd(
				fileSize,
				' ',
			);
		for (let i = 0; i < totalFiles; i++) {
			fs.writeFileSync(path.join(tmpDir, `F${i}.java`), content);
		}
		const eps = await backend.selectEntryPoints!(tmpDir);
		expect(eps.length).toBeGreaterThan(0);
		expect(eps.length).toBeLessThan(totalFiles);
	});

	test('bounds directory-walk breadth even with zero .java files', async () => {
		// A tree with many subdirectories but no .java files anywhere costs
		// real synchronous time in readdirSync/statSync calls even though
		// the byte caps (which only apply to .java files) never engage.
		// Discriminating regression test: place a REAL main-class .java
		// file in a directory that sorts alphabetically LAST, behind more
		// junk directories than MAX_ENTRY_POINT_ENTRIES. The LIFO walk
		// pushes entries in readdir order and pops in reverse, so the
		// alphabetically-last "target" directory is pushed first and would
		// only be popped (and its main class found) after every junk
		// directory ahead of it in the stack has been processed — which
		// the entries cap must prevent from ever completing. Pre-fix
		// (unbounded) code finds the main class regardless of junk-dir
		// count; post-fix code must not, once the cap is exceeded.
		const entriesCap = _internals.MAX_ENTRY_POINT_ENTRIES;
		const junkCount = entriesCap + 50;
		for (let i = 0; i < junkCount; i++) {
			fs.mkdirSync(path.join(tmpDir, `aaa_junk_${String(i).padStart(6, '0')}`));
		}
		const targetDir = path.join(tmpDir, 'zzz_target');
		fs.mkdirSync(targetDir);
		fs.writeFileSync(
			path.join(targetDir, 'Main.java'),
			'public class Main { public static void main(String[] args) {} }\n',
		);

		const start = performance.now();
		const eps = await backend.selectEntryPoints!(tmpDir);
		const elapsedMs = performance.now() - start;

		expect(eps).toEqual([]);
		// Not a tight timing assertion (CI machines vary), just confirms the
		// scan terminates promptly rather than doing unbounded work.
		expect(elapsedMs).toBeLessThan(10000);
	});

	test('ignores common non-Java output directories (out/, bin/, .venv/)', async () => {
		// Discriminating regression test: place a REAL main-class .java
		// file inside each ignored directory, asserted absent from the
		// result. Pre-fix (before out/bin/.venv were added to the ignore
		// set) code would find and return these; post-fix code must skip
		// them entirely.
		fs.writeFileSync(
			path.join(tmpDir, 'App.java'),
			'public class App { public static void main(String[] args) {} }\n',
		);
		for (const ignoredDir of ['out', 'bin', '.venv']) {
			const d = path.join(tmpDir, ignoredDir);
			fs.mkdirSync(d);
			for (let i = 0; i < 50; i++) {
				fs.writeFileSync(path.join(d, `f${i}.bin`), 'x'.repeat(1024));
			}
			fs.writeFileSync(
				path.join(d, 'Hidden.java'),
				'public class Hidden { public static void main(String[] args) {} }\n',
			);
		}
		const eps = await backend.selectEntryPoints!(tmpDir);
		expect(eps).toEqual(['App.java']);
	});

	test('finds src/main/java entry point even when src/test/java is large', async () => {
		// Regression: a LIFO directory walk that visits `src/test` before
		// `src/main` could exhaust the total-byte cap on test sources before
		// the real entry point in `src/main` was ever reached, silently
		// returning []. Prefer main-like directories over test directories
		// so the main class is still found regardless of readdir order.
		const mainDir = path.join(tmpDir, 'src', 'main', 'java', 'com', 'acme');
		fs.mkdirSync(mainDir, { recursive: true });
		fs.writeFileSync(
			path.join(mainDir, 'App.java'),
			'public class App { public static void main(String[] args) {} }\n',
		);
		const testDir = path.join(tmpDir, 'src', 'test', 'java', 'com', 'acme');
		fs.mkdirSync(testDir, { recursive: true });
		// Well over the 512KB total-byte cap if test sources were scanned
		// first: 200 files x ~6KB each.
		const testFileContent = 'x'.repeat(6 * 1024);
		for (let i = 0; i < 200; i++) {
			fs.writeFileSync(path.join(testDir, `Test${i}.java`), testFileContent);
		}
		const eps = await backend.selectEntryPoints!(tmpDir);
		expect(eps).toEqual([
			path.join('src', 'main', 'java', 'com', 'acme', 'App.java'),
		]);
	});
});
