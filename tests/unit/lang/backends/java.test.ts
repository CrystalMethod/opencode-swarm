/**
 * Java backend tests (DS-2).
 *
 * Covers the first-class Java `LanguageBackend`:
 *   - `buildJavaBackend` returns a backend for the `java` profile.
 *   - `extractImports` delegates to the shared `parseJavaImports`, mapping
 *     each parsed import to its `.specifier`, deduping while preserving order.
 *   - `selectTestFramework` prefers the Gradle wrapper `./gradlew` when
 *     present, falling back to the registry-driven default otherwise.
 *   - `selectEntryPoints` scans the tree for `.java` files declaring
 *     `public static void main`, returning repo-relative paths, bounded by
 *     depth/file caps and ignored directories.
 *   - `selectFramework` / `detectFramework` detect Spring vs Servlet.
 *   - `isMainClass` is a pure predicate over source text.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	buildJavaBackend,
	detectFramework,
	isMainClass,
} from '../../../../src/lang/backends/java';

describe('buildJavaBackend', () => {
	test('returns a LanguageBackend for the java profile', () => {
		const backend = buildJavaBackend();
		expect(backend.id).toBe('java');
		expect(backend.displayName).toBe('Java');
		expect(backend.extensions).toEqual(['.java']);
	});

	test('overrides all four Java-specific hooks', () => {
		const backend = buildJavaBackend();
		expect(typeof backend.extractImports).toBe('function');
		expect(typeof backend.selectTestFramework).toBe('function');
		expect(typeof backend.selectEntryPoints).toBe('function');
		expect(typeof backend.selectFramework).toBe('function');
	});
});

describe('extractImports', () => {
	const backend = buildJavaBackend();

	test('maps parseJavaImports specifiers for a multi-import source', () => {
		const src = `package com.example;

import java.util.List;
import java.util.Map;

public class App {}
`;
		expect(backend.extractImports!('App.java', src)).toEqual([
			'java.util.List',
			'java.util.Map',
		]);
	});

	test('dedupes repeated specifiers while preserving first-seen order', () => {
		const src = `import java.util.List;
import java.util.Map;
import java.util.List;
`;
		expect(backend.extractImports!('App.java', src)).toEqual([
			'java.util.List',
			'java.util.Map',
		]);
	});

	test('handles static and wildcard imports', () => {
		const src = `import static java.lang.Math.max;
import java.util.*;
`;
		expect(backend.extractImports!('App.java', src)).toEqual([
			'java.lang.Math',
			'java.util.*',
		]);
	});

	test('returns empty array for a source with no imports', () => {
		expect(backend.extractImports!('App.java', 'public class App {}')).toEqual(
			[],
		);
	});

	test('does not fabricate imports from comments or text blocks', () => {
		const src = `// import java.util.List;
/*
import java.util.Map;
*/
public class App {
	String s = """
		import java.util.Fake;
		""";
}
`;
		expect(backend.extractImports!('App.java', src)).toEqual([]);
	});
});

describe('selectTestFramework', () => {
	const backend = buildJavaBackend();
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'java-backend-tf-')),
		);
	});

	afterEach(() => {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	test('prefers ./gradlew when the wrapper is present', async () => {
		fs.writeFileSync(path.join(tmpDir, 'gradlew'), '#!/bin/sh\nexit 0\n');
		const sel = await backend.selectTestFramework!(tmpDir);
		expect(sel).not.toBeNull();
		expect(sel?.name).toBe('gradle');
		expect(sel?.cmd).toEqual(['./gradlew', 'test', '-q']);
		expect(sel?.cwd).toBe(tmpDir);
		expect(sel?.detectedVia).toBe('./gradlew');
	});

	test('prefers ./mvnw for a Maven project with the wrapper present', async () => {
		// Fresh Spring Initializr Maven fixture: pom.xml + mvnw, no
		// build.gradle, no gradlew. The wrapper is repo-local, so selection
		// must not depend on `mvn` being resolvable on PATH.
		fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project/>\n');
		fs.writeFileSync(path.join(tmpDir, 'mvnw'), '#!/bin/sh\nexit 0\n');
		const sel = await backend.selectTestFramework!(tmpDir);
		expect(sel).not.toBeNull();
		expect(sel?.name).toBe('maven');
		expect(sel?.cmd).toEqual(['./mvnw', 'test', '-q']);
		expect(sel?.cwd).toBe(tmpDir);
		expect(sel?.detectedVia).toBe('./mvnw');
	});

	test('gradlew wins when both wrappers are present', async () => {
		fs.writeFileSync(path.join(tmpDir, 'gradlew'), '#!/bin/sh\nexit 0\n');
		fs.writeFileSync(path.join(tmpDir, 'mvnw'), '#!/bin/sh\nexit 0\n');
		fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project/>\n');
		const sel = await backend.selectTestFramework!(tmpDir);
		expect(sel?.name).toBe('gradle');
		expect(sel?.detectedVia).toBe('./gradlew');
	});

	test('falls back to the default selection when no gradlew is present', async () => {
		// Empty dir: no gradlew, no pom.xml/build.gradle detect file → the
		// default registry-driven selection finds no framework and returns null.
		const sel = await backend.selectTestFramework!(tmpDir);
		expect(sel).toBeNull();
	});

	test('resolves to gradlew.bat on Windows when gradlew.bat is present', async () => {
		const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
		try {
			Object.defineProperty(process, 'platform', { value: 'win32' });
			fs.writeFileSync(path.join(tmpDir, 'gradlew'), '#!/bin/sh\nexit 0\n');
			fs.writeFileSync(path.join(tmpDir, 'gradlew.bat'), '@echo off\n');
			const sel = await backend.selectTestFramework!(tmpDir);
			expect(sel?.name).toBe('gradle');
			expect(sel?.cmd).toEqual(['gradlew.bat', 'test', '-q']);
		} finally {
			if (origPlatform) {
				Object.defineProperty(process, 'platform', origPlatform);
			}
		}
	});

	test('resolves to ./gradlew on Windows when gradlew.bat is absent', async () => {
		const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
		try {
			Object.defineProperty(process, 'platform', { value: 'win32' });
			fs.writeFileSync(path.join(tmpDir, 'gradlew'), '#!/bin/sh\nexit 0\n');
			const sel = await backend.selectTestFramework!(tmpDir);
			expect(sel?.name).toBe('gradle');
			expect(sel?.cmd).toEqual(['./gradlew', 'test', '-q']);
		} finally {
			if (origPlatform) {
				Object.defineProperty(process, 'platform', origPlatform);
			}
		}
	});

	test('resolves to ./gradlew on non-Windows even when gradlew.bat is present', async () => {
		if (process.platform === 'win32') return;
		fs.writeFileSync(path.join(tmpDir, 'gradlew'), '#!/bin/sh\nexit 0\n');
		fs.writeFileSync(path.join(tmpDir, 'gradlew.bat'), '@echo off\n');
		const sel = await backend.selectTestFramework!(tmpDir);
		expect(sel?.name).toBe('gradle');
		expect(sel?.cmd).toEqual(['./gradlew', 'test', '-q']);
	});
});

describe('selectEntryPoints', () => {
	const backend = buildJavaBackend();
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'java-backend-ep-')),
		);
	});

	afterEach(() => {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	test('returns repo-relative paths for main-class .java files', async () => {
		const mainDir = path.join(tmpDir, 'src', 'main', 'java', 'com', 'example');
		fs.mkdirSync(mainDir, { recursive: true });
		fs.writeFileSync(
			path.join(mainDir, 'App.java'),
			'public class App {\n  public static void main(String[] args) {}\n}\n',
		);
		fs.writeFileSync(
			path.join(mainDir, 'Helper.java'),
			'public class Helper { public int add(int a, int b) { return a + b; } }\n',
		);

		const eps = await backend.selectEntryPoints!(tmpDir);
		expect(eps).toEqual([
			path.join('src', 'main', 'java', 'com', 'example', 'App.java'),
		]);
	});

	test('skips ignored directories (target, .git, node_modules)', async () => {
		fs.mkdirSync(path.join(tmpDir, 'target'), { recursive: true });
		fs.writeFileSync(
			path.join(tmpDir, 'target', 'Generated.java'),
			'public class Generated { public static void main(String[] args) {} }\n',
		);
		fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
		fs.writeFileSync(
			path.join(tmpDir, '.git', 'Hook.java'),
			'public class Hook { public static void main(String[] args) {} }\n',
		);

		const eps = await backend.selectEntryPoints!(tmpDir);
		expect(eps).toEqual([]);
	});

	test('returns empty for a directory with no .java files', async () => {
		fs.writeFileSync(path.join(tmpDir, 'README.md'), 'no java here\n');
		const eps = await backend.selectEntryPoints!(tmpDir);
		expect(eps).toEqual([]);
	});

	test('does not crash on an unreadable subdirectory', async () => {
		// A directory that cannot be read is skipped rather than throwing.
		const locked = path.join(tmpDir, 'locked');
		fs.mkdirSync(locked, { recursive: true });
		fs.chmodSync(locked, 0o000);
		try {
			const eps = await backend.selectEntryPoints!(tmpDir);
			expect(Array.isArray(eps)).toBe(true);
		} finally {
			fs.chmodSync(locked, 0o755);
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

describe('selectFramework', () => {
	const backend = buildJavaBackend();
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'java-backend-fw-')),
		);
	});

	afterEach(() => {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	test('detects spring from pom.xml with spring-boot-starter-web', async () => {
		fs.writeFileSync(
			path.join(tmpDir, 'pom.xml'),
			'<dependency><groupId>org.springframework.boot</groupId>' +
				'<artifactId>spring-boot-starter-web</artifactId></dependency>\n',
		);
		const sel = await backend.selectFramework!(tmpDir);
		expect(sel?.name).toBe('spring');
	});

	test('detects servlet from build.gradle with jakarta.servlet', async () => {
		fs.writeFileSync(
			path.join(tmpDir, 'build.gradle'),
			"dependencies { implementation 'jakarta.servlet:jakarta.servlet-api:6.0.0' }\n",
		);
		const sel = await backend.selectFramework!(tmpDir);
		expect(sel?.name).toBe('servlet');
	});

	test('returns null for a directory with no manifest', async () => {
		const sel = await backend.selectFramework!(tmpDir);
		expect(sel).toBeNull();
	});
});

describe('isMainClass', () => {
	test('true for a public static void main declaration', () => {
		expect(isMainClass('public static void main(String[] args) {}')).toBe(true);
		expect(
			isMainClass(
				'  public static void main(String[] args) {\n    // body\n  }',
			),
		).toBe(true);
	});

	test('false for non-main methods and non-public main', () => {
		expect(isMainClass('public void main(String[] args) {}')).toBe(false);
		expect(isMainClass('static void main(String[] args) {}')).toBe(false);
		expect(isMainClass('public int add(int a, int b) { return a + b; }')).toBe(
			false,
		);
		expect(isMainClass('')).toBe(false);
	});
});

describe('detectFramework', () => {
	test('returns spring for spring-boot / spring-web / spring-context content', () => {
		expect(detectFramework('spring-boot-starter-web')).toEqual({
			name: 'spring',
			detectedVia: 'spring-boot/spring dependency',
		});
		expect(detectFramework('org.springframework:spring-web')).toEqual({
			name: 'spring',
			detectedVia: 'spring-boot/spring dependency',
		});
	});

	test('returns servlet for jakarta.servlet / javax.servlet content', () => {
		expect(detectFramework('jakarta.servlet:jakarta.servlet-api')).toEqual({
			name: 'servlet',
			detectedVia: 'jakarta/javax servlet dependency',
		});
		expect(detectFramework('javax.servlet:javax.servlet-api')).toEqual({
			name: 'servlet',
			detectedVia: 'jakarta/javax servlet dependency',
		});
	});

	test('returns null for empty or unrelated content', () => {
		expect(detectFramework('')).toBeNull();
		expect(detectFramework('com.google.guava:guava')).toBeNull();
		expect(detectFramework('junit:junit')).toBeNull();
	});
});

describe('_internals seam', () => {
	test('exposes the pure helpers for direct testing', () => {
		expect(typeof _internals.extractImports).toBe('function');
		expect(typeof _internals.isMainClass).toBe('function');
		expect(typeof _internals.detectFramework).toBe('function');
	});

	test('_internals.extractImports matches the backend hook behavior', () => {
		const src = 'import java.util.List;\nimport java.util.Map;\n';
		expect(_internals.extractImports('App.java', src)).toEqual([
			'java.util.List',
			'java.util.Map',
		]);
	});

	test('exposes the extracted wrapper helpers for direct testing', () => {
		expect(typeof _internals.wrapperExists).toBe('function');
		expect(typeof _internals.resolveMvnwCommand).toBe('function');
		expect(typeof _internals.resolveGradlewCommand).toBe('function');
	});
});

describe('wrapperExists', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'java-backend-we-')),
		);
	});

	afterEach(() => {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	test('true when the named wrapper file exists', () => {
		fs.writeFileSync(path.join(tmpDir, 'gradlew'), '#!/bin/sh\nexit 0\n');
		expect(_internals.wrapperExists(tmpDir, 'gradlew')).toBe(true);
	});

	test('false when the named wrapper file is absent', () => {
		expect(_internals.wrapperExists(tmpDir, 'gradlew')).toBe(false);
		expect(_internals.wrapperExists(tmpDir, 'mvnw')).toBe(false);
	});
});

describe('resolveMvnwCommand', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'java-backend-mvnw-')),
		);
	});

	afterEach(() => {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	test('returns ./mvnw when mvnw.cmd is absent', () => {
		fs.writeFileSync(path.join(tmpDir, 'mvnw'), '#!/bin/sh\nexit 0\n');
		expect(_internals.resolveMvnwCommand(tmpDir)).toBe('./mvnw');
	});

	test('returns ./mvnw on non-Windows even when mvnw.cmd is present', () => {
		if (process.platform === 'win32') return;
		fs.writeFileSync(path.join(tmpDir, 'mvnw'), '#!/bin/sh\nexit 0\n');
		fs.writeFileSync(path.join(tmpDir, 'mvnw.cmd'), '@echo off\n');
		expect(_internals.resolveMvnwCommand(tmpDir)).toBe('./mvnw');
	});
});

describe('resolveGradlewCommand', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'java-backend-gradlew-')),
		);
	});

	afterEach(() => {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	test('returns gradlew.bat on Windows when gradlew.bat is present', () => {
		const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
		try {
			Object.defineProperty(process, 'platform', { value: 'win32' });
			fs.writeFileSync(path.join(tmpDir, 'gradlew'), '#!/bin/sh\nexit 0\n');
			fs.writeFileSync(path.join(tmpDir, 'gradlew.bat'), '@echo off\n');
			expect(_internals.resolveGradlewCommand(tmpDir)).toBe('gradlew.bat');
		} finally {
			if (origPlatform) {
				Object.defineProperty(process, 'platform', origPlatform);
			}
		}
	});

	test('returns ./gradlew on Windows when gradlew.bat is absent', () => {
		const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
		try {
			Object.defineProperty(process, 'platform', { value: 'win32' });
			fs.writeFileSync(path.join(tmpDir, 'gradlew'), '#!/bin/sh\nexit 0\n');
			expect(_internals.resolveGradlewCommand(tmpDir)).toBe('./gradlew');
		} finally {
			if (origPlatform) {
				Object.defineProperty(process, 'platform', origPlatform);
			}
		}
	});

	test('returns ./gradlew on non-Windows even when gradlew.bat is present', () => {
		if (process.platform === 'win32') return;
		fs.writeFileSync(path.join(tmpDir, 'gradlew'), '#!/bin/sh\nexit 0\n');
		fs.writeFileSync(path.join(tmpDir, 'gradlew.bat'), '@echo off\n');
		expect(_internals.resolveGradlewCommand(tmpDir)).toBe('./gradlew');
	});
});
