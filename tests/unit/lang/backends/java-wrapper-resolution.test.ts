import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals } from '../../../../src/lang/backends/java';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

describe('wrapperExists', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = canonicalMkdtemp('java-backend-we-');
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
		tmpDir = canonicalMkdtemp('java-backend-mvnw-');
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
		tmpDir = canonicalMkdtemp('java-backend-gradlew-');
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
