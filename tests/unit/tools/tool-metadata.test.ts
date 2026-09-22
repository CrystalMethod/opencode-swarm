import { describe, test, expect } from 'bun:test';
import { TOOL_METADATA } from '../../../src/tools/tool-metadata';

const symbolsMeta = TOOL_METADATA.symbols;

describe('symbols tool metadata', () => {
	test('description includes Java in the supported-languages list', () => {
		expect(symbolsMeta.description).toContain('Java');
	});

	test('description includes every other supported language', () => {
		const supported = [
			'TypeScript',
			'JavaScript',
			'Python',
			'Rust',
			'Go',
			'Dart',
			'Ruby',
			'PHP',
		];
		for (const lang of supported) {
			expect(symbolsMeta.description).toContain(lang);
		}
	});

	test('description lists Java alongside the other languages in one sentence', () => {
		// The supported-languages clause should enumerate all languages including Java.
		expect(symbolsMeta.description).toMatch(
			/supports TypeScript, JavaScript, Python, Rust, Go, Dart, Ruby, PHP, and Java/,
		);
	});

	test('agents list is non-empty', () => {
		expect(symbolsMeta.agents.length).toBeGreaterThan(0);
	});

	test('agents list includes architect', () => {
		expect(symbolsMeta.agents).toContain('architect');
	});
});
