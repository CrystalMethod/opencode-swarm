import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildJavaBackend } from '../../../../src/lang/backends/java';

describe('selectEntryPoints size caps', () => {
	const backend = buildJavaBackend();
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'java-backend-ep-caps-')),
		);
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
});
