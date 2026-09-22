import { describe, expect, test } from 'bun:test';
import { JAVA_SYMBOL_GRAMMAR, parseJavaImports } from './java-extraction';

/**
 * Snapshot of the Java grammar as defined in `src/lang/symbol-graph.ts`
 * (lines ~212-241, the `java` entry of the module-private `QUERIES` map).
 * `QUERIES` is not exported, so this snapshot is the drift-check oracle:
 * `JAVA_SYMBOL_GRAMMAR` must remain byte-identical to it.
 */
const SOURCE_JAVA_GRAMMAR = {
	defs: `
		(method_declaration
			(identifier) @func.name
		) @func.def
		(constructor_declaration
			(identifier) @ctor.name
		) @ctor.def
		(class_declaration
			(identifier) @class.name
		) @class.def
		(interface_declaration
			(identifier) @interface.name
		) @interface.def
		(enum_declaration
			(identifier) @enum.name
		) @enum.def
		(record_declaration
			(identifier) @record.name
		) @record.def
	`,
	imports: `
		(import_declaration) @import
	`,
	refs: `
		(identifier) @ref.identifier
		(type_identifier) @ref.identifier
	`,
	exports: ``,
};

/** Collapses leading/trailing whitespace and blank lines for whitespace-insensitive comparison. */
function normalizeQuery(q: string): string {
	return q
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.join('\n');
}

describe('JAVA_SYMBOL_GRAMMAR', () => {
	test('is exported with the expected defs/imports/refs/exports structure', () => {
		expect(JAVA_SYMBOL_GRAMMAR).toEqual({
			defs: expect.any(String),
			imports: expect.any(String),
			refs: expect.any(String),
			exports: expect.any(String),
		});
	});

	test('defs/imports/refs query sets are present and non-empty', () => {
		expect(JAVA_SYMBOL_GRAMMAR.defs.length).toBeGreaterThan(0);
		expect(JAVA_SYMBOL_GRAMMAR.imports.length).toBeGreaterThan(0);
		expect(JAVA_SYMBOL_GRAMMAR.refs.length).toBeGreaterThan(0);
		// exports is intentionally empty for Java (no export statements).
		expect(JAVA_SYMBOL_GRAMMAR.exports).toBe('');
	});

	test('defs covers all six Java declaration node types', () => {
		const defs = JAVA_SYMBOL_GRAMMAR.defs;
		expect(defs).toContain('(method_declaration');
		expect(defs).toContain('(constructor_declaration');
		expect(defs).toContain('(class_declaration');
		expect(defs).toContain('(interface_declaration');
		expect(defs).toContain('(enum_declaration');
		expect(defs).toContain('(record_declaration');
		expect(defs).toContain('@func.name');
		expect(defs).toContain('@ctor.name');
		expect(defs).toContain('@class.name');
		expect(defs).toContain('@interface.name');
		expect(defs).toContain('@enum.name');
		expect(defs).toContain('@record.name');
	});

	test('imports matches the import_declaration node', () => {
		expect(JAVA_SYMBOL_GRAMMAR.imports).toContain(
			'(import_declaration) @import',
		);
	});

	test('refs matches both identifier and type_identifier nodes', () => {
		const refs = JAVA_SYMBOL_GRAMMAR.refs;
		expect(refs).toContain('(identifier) @ref.identifier');
		expect(refs).toContain('(type_identifier) @ref.identifier');
	});

	test('defs/imports/refs query strings match the source grammar (no drift)', () => {
		expect(JAVA_SYMBOL_GRAMMAR.defs).toBe(SOURCE_JAVA_GRAMMAR.defs);
		expect(JAVA_SYMBOL_GRAMMAR.imports).toBe(SOURCE_JAVA_GRAMMAR.imports);
		expect(JAVA_SYMBOL_GRAMMAR.refs).toBe(SOURCE_JAVA_GRAMMAR.refs);
		expect(JAVA_SYMBOL_GRAMMAR.exports).toBe(SOURCE_JAVA_GRAMMAR.exports);
	});

	test('normalized query content matches the source grammar (whitespace-insensitive)', () => {
		expect(normalizeQuery(JAVA_SYMBOL_GRAMMAR.defs)).toBe(
			normalizeQuery(SOURCE_JAVA_GRAMMAR.defs),
		);
		expect(normalizeQuery(JAVA_SYMBOL_GRAMMAR.imports)).toBe(
			normalizeQuery(SOURCE_JAVA_GRAMMAR.imports),
		);
		expect(normalizeQuery(JAVA_SYMBOL_GRAMMAR.refs)).toBe(
			normalizeQuery(SOURCE_JAVA_GRAMMAR.refs),
		);
	});
});

describe('parseJavaImports', () => {
	test('single named import', () => {
		const result = parseJavaImports('package com.example;\nimport a.b.C;\n');
		expect(result).toEqual([
			{
				specifier: 'a.b.C',
				importType: 'named',
				bindings: [{ imported: 'C', local: 'C' }],
			},
		]);
	});

	test('single named import without trailing semicolon', () => {
		const result = parseJavaImports('import a.b.C');
		expect(result).toEqual([
			{
				specifier: 'a.b.C',
				importType: 'named',
				bindings: [{ imported: 'C', local: 'C' }],
			},
		]);
	});

	test('multiple imports in one file, in source order', () => {
		const result = parseJavaImports(
			[
				'import alpha.one.A;',
				'import beta.two.B;',
				'import gamma.three.C;',
			].join('\n'),
		);
		expect(result).toEqual([
			{
				specifier: 'alpha.one.A',
				importType: 'named',
				bindings: [{ imported: 'A', local: 'A' }],
			},
			{
				specifier: 'beta.two.B',
				importType: 'named',
				bindings: [{ imported: 'B', local: 'B' }],
			},
			{
				specifier: 'gamma.three.C',
				importType: 'named',
				bindings: [{ imported: 'C', local: 'C' }],
			},
		]);
	});

	test('static single-member import binds the member, specifier is enclosing type', () => {
		const result = parseJavaImports('import static a.b.C.m;\n');
		expect(result).toEqual([
			{
				specifier: 'a.b.C',
				importType: 'named',
				bindings: [{ imported: 'm', local: 'm' }],
			},
		]);
	});

	test('wildcard import is a namespace with no bindings', () => {
		const result = parseJavaImports('import a.b.*;\n');
		expect(result).toEqual([
			{
				specifier: 'a.b.*',
				importType: 'namespace',
				bindings: [],
			},
		]);
	});

	test('static wildcard import is a namespace with no bindings', () => {
		const result = parseJavaImports('import static a.b.*;\n');
		expect(result).toEqual([
			{
				specifier: 'a.b.*',
				importType: 'namespace',
				bindings: [],
			},
		]);
	});

	test('package-private file with no imports returns empty array', () => {
		expect(parseJavaImports('class Foo {}\n')).toEqual([]);
		expect(parseJavaImports('')).toEqual([]);
	});

	test('imports inside line comments are NOT matched', () => {
		const src = ['// import a.b.C;', 'class Foo {}'].join('\n');
		expect(parseJavaImports(src)).toEqual([]);
	});

	test('imports inside block comments are NOT matched', () => {
		const src = ['/*', ' * import a.b.C;', ' */', 'class Foo {}'].join('\n');
		expect(parseJavaImports(src)).toEqual([]);
	});

	test('imports inside Java text blocks are NOT matched', () => {
		const src = [
			'class Foo {',
			'  String s = """',
			'  import fake.Imported;',
			'  """;',
			'}',
		].join('\n');
		expect(parseJavaImports(src)).toEqual([]);
	});

	test('real import before a text block is still matched', () => {
		const src = [
			'import real.Thing;',
			'class Foo {',
			'  String s = """',
			'  import fake.Imported;',
			'  """;',
			'}',
		].join('\n');
		expect(parseJavaImports(src)).toEqual([
			{
				specifier: 'real.Thing',
				importType: 'named',
				bindings: [{ imported: 'Thing', local: 'Thing' }],
			},
		]);
	});

	test('imports with unusual whitespace are matched', () => {
		const result = parseJavaImports(
			'\t import   a.b.C   ;   \r\nimport\tstatic\tx.y.Z.m ;',
		);
		expect(result).toEqual([
			{
				specifier: 'a.b.C',
				importType: 'named',
				bindings: [{ imported: 'C', local: 'C' }],
			},
			{
				specifier: 'x.y.Z',
				importType: 'named',
				bindings: [{ imported: 'm', local: 'm' }],
			},
		]);
	});

	test('mixed import kinds in a single file', () => {
		const src = [
			'import a.b.C;',
			'import static a.b.C.m;',
			'import d.e.*;',
			'import static d.e.*;',
		].join('\n');
		expect(parseJavaImports(src)).toEqual([
			{
				specifier: 'a.b.C',
				importType: 'named',
				bindings: [{ imported: 'C', local: 'C' }],
			},
			{
				specifier: 'a.b.C',
				importType: 'named',
				bindings: [{ imported: 'm', local: 'm' }],
			},
			{ specifier: 'd.e.*', importType: 'namespace', bindings: [] },
			{ specifier: 'd.e.*', importType: 'namespace', bindings: [] },
		]);
	});

	test('single-segment import (default package) is a named binding', () => {
		const result = parseJavaImports('import Foo;\n');
		expect(result).toEqual([
			{
				specifier: 'Foo',
				importType: 'named',
				bindings: [{ imported: 'Foo', local: 'Foo' }],
			},
		]);
	});
});
