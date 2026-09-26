/**
 * Backend registration tests (DS-2).
 *
 * Verifies `registerAllBackends()` from `src/lang/backends/index.ts`:
 *   - registers the first-class `java` backend,
 *   - is idempotent (a second call does not throw),
 *   - `_resetForTesting()` unregisters `java`,
 *   - the existing backends (typescript, python, go, php) remain registered
 *     after registration (no regression).
 *
 * Uses `_resetForTesting()` in `afterEach` and re-registers to avoid
 * cross-file singleton pollution of `LANGUAGE_BACKEND_REGISTRY`.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
	_resetForTesting,
	registerAllBackends,
} from '../../../../src/lang/backends/index';
import { LANGUAGE_BACKEND_REGISTRY } from '../../../../src/lang/registry-backend';

const EXISTING_BACKENDS = ['typescript', 'python', 'go', 'php'];

afterEach(() => {
	// Reset the singleton registry and re-register so other test files in
	// the same process observe the normal registered state.
	_resetForTesting();
	registerAllBackends();
});

describe('registerAllBackends', () => {
	test('registers the java backend', () => {
		_resetForTesting();
		registerAllBackends();
		const java = LANGUAGE_BACKEND_REGISTRY.get('java');
		expect(java).toBeDefined();
		expect(java?.id).toBe('java');
	});

	test('is idempotent — calling twice does not throw', () => {
		_resetForTesting();
		registerAllBackends();
		expect(() => registerAllBackends()).not.toThrow();
		// Still exactly one java backend registered after the second call.
		expect(LANGUAGE_BACKEND_REGISTRY.get('java')?.id).toBe('java');
	});

	test('keeps existing backends registered (no regression)', () => {
		_resetForTesting();
		registerAllBackends();
		for (const id of EXISTING_BACKENDS) {
			expect(LANGUAGE_BACKEND_REGISTRY.get(id)?.id).toBe(id);
		}
	});

	test('registers all five backends together', () => {
		_resetForTesting();
		registerAllBackends();
		for (const id of [...EXISTING_BACKENDS, 'java']) {
			expect(LANGUAGE_BACKEND_REGISTRY.get(id)?.id).toBe(id);
		}
	});
});

describe('_resetForTesting', () => {
	test('unregisters java', () => {
		_resetForTesting();
		expect(LANGUAGE_BACKEND_REGISTRY.get('java')).toBeUndefined();
	});

	test('unregisters all backends', () => {
		_resetForTesting();
		for (const id of [...EXISTING_BACKENDS, 'java']) {
			expect(LANGUAGE_BACKEND_REGISTRY.get(id)).toBeUndefined();
		}
	});

	test('re-registration after reset restores java', () => {
		_resetForTesting();
		expect(LANGUAGE_BACKEND_REGISTRY.get('java')).toBeUndefined();
		registerAllBackends();
		expect(LANGUAGE_BACKEND_REGISTRY.get('java')?.id).toBe('java');
	});
});
