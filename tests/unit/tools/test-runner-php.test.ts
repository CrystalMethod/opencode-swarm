import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearDispatchCache } from '../../../src/lang/dispatch';
import {
	buildTestCommandViaDispatch,
	detectTestFramework,
	detectTestFrameworkViaDispatch,
} from '../../../src/tools/test-runner';

let tempDir: string;

beforeEach(() => {
	clearDispatchCache();
	tempDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-php-')),
	);
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
	clearDispatchCache();
});

describe('PHP test_runner support', () => {
	test('detects PHPUnit through legacy and dispatch paths', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'composer.json'),
			JSON.stringify({ name: 'acme/app' }),
		);
		fs.writeFileSync(path.join(tempDir, 'phpunit.xml'), '<phpunit />');

		expect(await detectTestFramework(tempDir)).toBe('phpunit');
		expect(await detectTestFrameworkViaDispatch(tempDir)).toBe('phpunit');
	});

	test('builds file-scoped PHPUnit commands through dispatch', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'composer.json'),
			JSON.stringify({ name: 'acme/app' }),
		);
		fs.writeFileSync(path.join(tempDir, 'phpunit.xml'), '<phpunit />');

		const cmd = await buildTestCommandViaDispatch(
			'phpunit',
			'convention',
			['tests/Feature/HealthTest.php'],
			false,
			tempDir,
			false,
		);

		// #3050: on win32 the Composer `.bat` shim is never a raw spawn target —
		// it routes through the contained cmd.exe launcher, or falls back to the
		// PHP interpreter on the extensionless proxy. This fixture creates NO
		// `vendor/bin/phpunit` at all, so BOTH the shim and the proxy are absent
		// and the builder deliberately emits the bare proxy: there is nothing to
		// launch, and a bare target surfaces as a `spawnError` ("the process
		// could not be started") rather than letting `php` start and then exit 1
		// on a missing file, which would read as a test regression with 0/0 run.
		// Identical on win32 and POSIX, so one expectation covers both.
		// See php-vendor-bin-launcher-3050.test.ts for the launcher-branch cases.
		expect(cmd).toEqual([
			path.join('vendor', 'bin', 'phpunit'),
			'tests/Feature/HealthTest.php',
		]);
	});

	test('detects Laravel (php-artisan) through legacy and dispatch paths', async () => {
		// Laravel projects have an `artisan` file and `composer.json`
		fs.writeFileSync(
			path.join(tempDir, 'artisan'),
			'#!/usr/bin/env php\n<?php\n',
		);
		fs.writeFileSync(
			path.join(tempDir, 'composer.json'),
			JSON.stringify({
				name: 'laravel/laravel',
				require: { 'laravel/framework': '^10.0' },
			}),
		);

		expect(await detectTestFramework(tempDir)).toBe('php-artisan');
		expect(await detectTestFrameworkViaDispatch(tempDir)).toBe('php-artisan');
	});

	test('detects Pest through legacy and dispatch paths', async () => {
		// Pest projects have a Pest.php file in the project root
		fs.writeFileSync(path.join(tempDir, 'Pest.php'), '<?php\n');
		fs.writeFileSync(
			path.join(tempDir, 'composer.json'),
			JSON.stringify({ name: 'pest/pest' }),
		);

		expect(await detectTestFramework(tempDir)).toBe('pest');
		expect(await detectTestFrameworkViaDispatch(tempDir)).toBe('pest');
	});
});
