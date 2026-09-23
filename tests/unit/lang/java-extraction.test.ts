/**
 * Shared Java extraction module tests (DS-1).
 *
 * Covers the two exports of `src/lang/java-extraction.ts`:
 *   - `parseJavaImports` — the reconciled import parser (named, static,
 *     wildcard, package-private, comment/text-block masking, source order).
 *   - `JAVA_SYMBOL_GRAMMAR` — the tree-sitter Java symbol grammar (defs /
 *     imports / refs / exports query sets).
 *
 * These are pure functions/constants, so all tests exercise real behavior
 * directly without mocks or a filesystem.
 */

import { describe, expect, test } from 'bun:test';
import {
	JAVA_SYMBOL_GRAMMAR,
	parseJavaImports,
} from '../../../src/lang/java-extraction';

/**
 * Snapshot of the Java grammar as defined in `src/lang/java-extraction.ts`
 * (the `JAVA_SYMBOL_GRAMMAR` export). This snapshot is the drift-check oracle:
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

describe('parseJavaImports', () => {
	test('returns an empty array for a source with no imports', () => {
		expect(parseJavaImports('public class App {}')).toEqual([]);
		expect(parseJavaImports('')).toEqual([]);
	});

	test('parses a single named import with its bound name', () => {
		expect(parseJavaImports('import java.util.List;\n')).toEqual([
			{
				specifier: 'java.util.List',
				importType: 'named',
				bindings: [{ imported: 'List', local: 'List' }],
			},
		]);
	});

	test('parses multiple imports in source order', () => {
		const src = `import java.util.List;
import java.util.Map;
import java.io.File;
`;
		expect(parseJavaImports(src).map((i) => i.specifier)).toEqual([
			'java.util.List',
			'java.util.Map',
			'java.io.File',
		]);
	});

	test('parses a static single-member import binding the member name', () => {
		expect(parseJavaImports('import static java.lang.Math.max;\n')).toEqual([
			{
				specifier: 'java.lang.Math',
				importType: 'named',
				bindings: [{ imported: 'max', local: 'max' }],
			},
		]);
	});

	test('parses a wildcard import as a namespace with no bindings', () => {
		expect(parseJavaImports('import java.util.*;\n')).toEqual([
			{
				specifier: 'java.util.*',
				importType: 'namespace',
				bindings: [],
			},
		]);
	});

	test('parses a static wildcard import as a namespace with no bindings', () => {
		expect(parseJavaImports('import static java.lang.Math.*;\n')).toEqual([
			{
				specifier: 'java.lang.Math.*',
				importType: 'namespace',
				bindings: [],
			},
		]);
	});

	test('handles imports without a trailing semicolon', () => {
		expect(parseJavaImports('import java.util.List')).toEqual([
			{
				specifier: 'java.util.List',
				importType: 'named',
				bindings: [{ imported: 'List', local: 'List' }],
			},
		]);
	});

	test('matches indented imports (leading whitespace)', () => {
		expect(
			parseJavaImports('\timport java.util.List;\n').map((i) => i.specifier),
		).toEqual(['java.util.List']);
	});

	test('parses imports in a file with a package declaration', () => {
		const src = `package com.example;

import com.example.model.User;
import com.example.util.Helper;
`;
		expect(parseJavaImports(src).map((i) => i.specifier)).toEqual([
			'com.example.model.User',
			'com.example.util.Helper',
		]);
	});

	test('does not fabricate imports from line comments', () => {
		const src = `// import java.util.List;
public class App {}
`;
		expect(parseJavaImports(src)).toEqual([]);
	});

	test('does not fabricate imports from block comments', () => {
		const src = `/*
import java.util.List;
import java.util.Map;
*/
public class App {}
`;
		expect(parseJavaImports(src)).toEqual([]);
	});

	test('does not lose imports after a block comment containing an apostrophe', () => {
		const src =
			"/* (c) Foo's Inc. */\nimport a.b.C;\n/* later comment */\npublic class X {}\n";
		const imports = parseJavaImports(src);
		expect(imports).toEqual([
			{
				specifier: 'a.b.C',
				importType: 'named',
				bindings: [{ imported: 'C', local: 'C' }],
			},
		]);
	});

	test('does not lose imports after a block comment with an apostrophe followed by more code', () => {
		const src =
			"/* Don't strip this comment's terminator */\nimport x.y.Z;\nclass Y { /* trailing comment */ }\n";
		const imports = parseJavaImports(src);
		expect(imports).toEqual([
			{
				specifier: 'x.y.Z',
				importType: 'named',
				bindings: [{ imported: 'Z', local: 'Z' }],
			},
		]);
	});

	test('does not fabricate imports from Java text blocks', () => {
		const src = `public class App {
	String s = """
		import java.util.Fake;
		import java.util.AlsoFake;
		""";
}
`;
		expect(parseJavaImports(src)).toEqual([]);
	});

	test('does not fabricate imports from a single-line string literal', () => {
		const src = `public class App {
	String s = "import java.util.Fake;";
}
`;
		expect(parseJavaImports(src)).toEqual([]);
	});

	test('does not corrupt a string literal containing //', () => {
		const src = `public class App {
	String url = "https://example.com/import java.util.Fake;";
}
`;
		expect(parseJavaImports(src)).toEqual([]);
	});

	test('does not corrupt a string literal containing /*', () => {
		const src = `public class App {
	String s = "a /* import java.util.Fake; */ b";
}
`;
		expect(parseJavaImports(src)).toEqual([]);
	});

	test('does not fabricate imports from a char literal', () => {
		const src = `public class App {
	char c = 'i';
}
`;
		expect(parseJavaImports(src)).toEqual([]);
	});

	test('does not fabricate imports from a char literal containing a double quote', () => {
		// A char literal holding a double-quote must not be mistaken for the
		// opening of a string literal that would swallow a following import.
		const src = `public class App {
	char q = '"';
}
import java.util.List;
`;
		expect(parseJavaImports(src).map((i) => i.specifier)).toEqual([
			'java.util.List',
		]);
	});

	test('does not fabricate imports from a char literal containing an escaped quote', () => {
		const src = `public class App {
	char q = '\\'';
}
import java.util.Map;
`;
		expect(parseJavaImports(src).map((i) => i.specifier)).toEqual([
			'java.util.Map',
		]);
	});

	test('does not fabricate imports from a string containing an escaped quote', () => {
		const src = `public class App {
	String s = "a \\" import java.util.Fake;";
}
`;
		expect(parseJavaImports(src)).toEqual([]);
	});

	test('parses real imports that surround a text block', () => {
		const src = `import java.util.List;
public class App {
	String s = """
		import java.util.Fake;
		""";
}
import java.util.Map;
`;
		expect(parseJavaImports(src).map((i) => i.specifier)).toEqual([
			'java.util.List',
			'java.util.Map',
		]);
	});

	test('mixed named, static, and wildcard imports in one file', () => {
		const src = `import java.util.List;
import static java.lang.Math.max;
import java.util.*;
import static java.lang.Math.*;
`;
		expect(parseJavaImports(src)).toEqual([
			{
				specifier: 'java.util.List',
				importType: 'named',
				bindings: [{ imported: 'List', local: 'List' }],
			},
			{
				specifier: 'java.lang.Math',
				importType: 'named',
				bindings: [{ imported: 'max', local: 'max' }],
			},
			{ specifier: 'java.util.*', importType: 'namespace', bindings: [] },
			{ specifier: 'java.lang.Math.*', importType: 'namespace', bindings: [] },
		]);
	});
});

describe('JAVA_SYMBOL_GRAMMAR', () => {
	test('exposes the four query-set fields', () => {
		expect(Object.keys(JAVA_SYMBOL_GRAMMAR).sort()).toEqual([
			'defs',
			'exports',
			'imports',
			'refs',
		]);
	});

	test('defs covers class, interface, enum, record, method, and constructor declarations', () => {
		expect(JAVA_SYMBOL_GRAMMAR.defs).toContain('class_declaration');
		expect(JAVA_SYMBOL_GRAMMAR.defs).toContain('interface_declaration');
		expect(JAVA_SYMBOL_GRAMMAR.defs).toContain('enum_declaration');
		expect(JAVA_SYMBOL_GRAMMAR.defs).toContain('record_declaration');
		expect(JAVA_SYMBOL_GRAMMAR.defs).toContain('method_declaration');
		expect(JAVA_SYMBOL_GRAMMAR.defs).toContain('constructor_declaration');
	});

	test('defs binds name and def captures for each declaration kind', () => {
		expect(JAVA_SYMBOL_GRAMMAR.defs).toContain('@class.name');
		expect(JAVA_SYMBOL_GRAMMAR.defs).toContain('@class.def');
		expect(JAVA_SYMBOL_GRAMMAR.defs).toContain('@interface.name');
		expect(JAVA_SYMBOL_GRAMMAR.defs).toContain('@enum.name');
		expect(JAVA_SYMBOL_GRAMMAR.defs).toContain('@record.name');
		expect(JAVA_SYMBOL_GRAMMAR.defs).toContain('@func.name');
		expect(JAVA_SYMBOL_GRAMMAR.defs).toContain('@func.def');
		expect(JAVA_SYMBOL_GRAMMAR.defs).toContain('@ctor.name');
		expect(JAVA_SYMBOL_GRAMMAR.defs).toContain('@ctor.def');
	});

	test('imports matches import_declaration nodes', () => {
		expect(JAVA_SYMBOL_GRAMMAR.imports).toContain('import_declaration');
		expect(JAVA_SYMBOL_GRAMMAR.imports).toContain('@import');
	});

	test('refs matches identifier and type_identifier nodes', () => {
		expect(JAVA_SYMBOL_GRAMMAR.refs).toContain('(identifier)');
		expect(JAVA_SYMBOL_GRAMMAR.refs).toContain('(type_identifier)');
		expect(JAVA_SYMBOL_GRAMMAR.refs).toContain('@ref.identifier');
	});

	test('exports is empty for Java (no export statement)', () => {
		expect(JAVA_SYMBOL_GRAMMAR.exports).toBe('');
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
