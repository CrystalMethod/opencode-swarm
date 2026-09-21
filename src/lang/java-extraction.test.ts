import { describe, test, expect } from 'bun:test';
import { parseJavaImports } from './java-extraction';

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
		const src = [
			'// import a.b.C;',
			'class Foo {}',
		].join('\n');
		expect(parseJavaImports(src)).toEqual([]);
	});

	test('imports inside block comments are NOT matched', () => {
		const src = [
			'/*',
			' * import a.b.C;',
			' */',
			'class Foo {}',
		].join('\n');
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
