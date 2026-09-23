import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractJavaSymbols, symbols } from '../../../src/tools/symbols';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let root: string;

function write(rel: string, content: string): void {
	const full = path.join(root, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, 'utf-8');
}

beforeEach(() => {
	root = canonicalMkdtemp('symbols-java-');
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe('symbols tool — java extractor (DS-3)', () => {
	test('extracts class, interface, enum, record, constructor, and method declarations', () => {
		write(
			'Foo.java',
			`package com.example;

public class Foo {
    private int count;
    public Foo() {}
    public void doWork(int x) {}
    private void helper() {}
    protected void prot() {}
    void pkgPrivate() {}
}

interface Bar {
    void run();
}

enum Color {
    RED, GREEN
}

record Point(int x, int y) {}
`,
		);

		const symbolsList = extractJavaSymbols('Foo.java', root);

		// class
		expect(symbolsList).toContainEqual(
			expect.objectContaining({ name: 'Foo', kind: 'class', exported: true }),
		);
		// constructor is reported as a method named after the class
		expect(symbolsList).toContainEqual(
			expect.objectContaining({ name: 'Foo', kind: 'method', exported: true }),
		);
		// method
		expect(symbolsList).toContainEqual(
			expect.objectContaining({
				name: 'doWork',
				kind: 'method',
				exported: true,
			}),
		);
		// interface
		expect(symbolsList).toContainEqual(
			expect.objectContaining({ name: 'Bar', kind: 'interface' }),
		);
		// enum
		expect(symbolsList).toContainEqual(
			expect.objectContaining({ name: 'Color', kind: 'enum' }),
		);
		// record maps to class kind
		expect(symbolsList).toContainEqual(
			expect.objectContaining({ name: 'Point', kind: 'class' }),
		);
	});

	test('exported reflects public visibility; package-private/private/protected are not exported', () => {
		write(
			'Vis.java',
			`public class PublicThing {}
class PackageThing {}
private class PrivateThing {}
public void publicMethod() {}
void packageMethod() {}
private void privateMethod() {}
protected void protectedMethod() {}
`,
		);

		const symbolsList = extractJavaSymbols('Vis.java', root);

		expect(symbolsList.find((s) => s.name === 'PublicThing')?.exported).toBe(
			true,
		);
		expect(symbolsList.find((s) => s.name === 'PackageThing')?.exported).toBe(
			false,
		);
		expect(symbolsList.find((s) => s.name === 'PrivateThing')?.exported).toBe(
			false,
		);
		expect(symbolsList.find((s) => s.name === 'publicMethod')?.exported).toBe(
			true,
		);
		expect(symbolsList.find((s) => s.name === 'packageMethod')?.exported).toBe(
			false,
		);
		expect(symbolsList.find((s) => s.name === 'privateMethod')?.exported).toBe(
			false,
		);
		expect(
			symbolsList.find((s) => s.name === 'protectedMethod')?.exported,
		).toBe(false);
	});

	test('public method with short name colliding with modifier substring remains exported', () => {
		write(
			'MethodModifierCollision.java',
			`public class MethodModifierCollision {
    public abstract void b() {}
}
`,
		);

		const symbolsList = extractJavaSymbols(
			'MethodModifierCollision.java',
			root,
		);

		expect(symbolsList.find((s) => s.name === 'b')?.exported).toBe(true);
	});

	test('public type declaration is unaffected by the method-branch lastIndexOf change (defensive parity check)', () => {
		// Defensive parity guard: typeDecl[1] is the declaration keyword (not type name), so this branch cannot hit the method-name collision bug with current modifiers.
		write('TypeModifierCollision.java', 'public final class l {}\n');

		const symbolsList = extractJavaSymbols('TypeModifierCollision.java', root);

		expect(
			symbolsList.find((s) => s.name === 'l' && s.kind === 'class')?.exported,
		).toBe(true);
	});

	test('exported is derived from matched modifier text, not the raw line (F-3 regression)', () => {
		write(
			'ExportFlag.java',
			`public class PublicThing {}
private class PrivateThing {}
public void publicMethod() {}
private void privateMethod() {}
protected void protectedMethod() {}
void packageMethod() {}
// a call-statement-shaped line with "public" inside a string literal:
setVisibility("public");
throw new IllegalArgumentException("must be public");
// a private method with "public" only in a trailing comment:
private void commented() {} // TODO: make public
`,
		);

		const symbolsList = extractJavaSymbols('ExportFlag.java', root);

		// genuine public declarations still report exported:true
		expect(symbolsList.find((s) => s.name === 'PublicThing')?.exported).toBe(
			true,
		);
		expect(symbolsList.find((s) => s.name === 'publicMethod')?.exported).toBe(
			true,
		);
		// private/protected/package-private report exported:false
		expect(symbolsList.find((s) => s.name === 'PrivateThing')?.exported).toBe(
			false,
		);
		expect(symbolsList.find((s) => s.name === 'privateMethod')?.exported).toBe(
			false,
		);
		expect(
			symbolsList.find((s) => s.name === 'protectedMethod')?.exported,
		).toBe(false);
		expect(symbolsList.find((s) => s.name === 'packageMethod')?.exported).toBe(
			false,
		);
		// a private method whose only "public" is in a trailing comment is not exported
		expect(symbolsList.find((s) => s.name === 'commented')?.exported).toBe(
			false,
		);
		// call-statement-shaped lines with "public" in a string are not exported
		expect(symbolsList.find((s) => s.name === 'setVisibility')?.exported).toBe(
			false,
		);
		expect(
			symbolsList.find((s) => s.name === 'IllegalArgumentException')?.exported,
		).toBe(false);
	});

	test('records map to the class kind', () => {
		write(
			'Point.java',
			`public record Point(int x, int y) {}
record Named(String name) {}
`,
		);

		const symbolsList = extractJavaSymbols('Point.java', root);
		expect(symbolsList.find((s) => s.name === 'Point')?.kind).toBe('class');
		expect(symbolsList.find((s) => s.name === 'Point')?.exported).toBe(true);
		expect(symbolsList.find((s) => s.name === 'Named')?.kind).toBe('class');
		expect(symbolsList.find((s) => s.name === 'Named')?.exported).toBe(false);
	});

	test('JAVA_KEYWORDS guard prevents control-flow lines from being reported as methods', () => {
		write(
			'Flow.java',
			`public class Flow {
    public void check(int x) {
        if (x > 0) {}
        for (int i = 0; i < x; i++) {}
        while (x > 0) { x--; }
        switch (x) {
            case 1: break;
        }
        return;
    }
}
`,
		);

		const symbolsList = extractJavaSymbols('Flow.java', root);
		const names = symbolsList.map((s) => s.name);

		expect(names).toContain('Flow');
		expect(names).toContain('check');
		expect(names).not.toContain('if');
		expect(names).not.toContain('for');
		expect(names).not.toContain('while');
		expect(names).not.toContain('switch');
		expect(names).not.toContain('case');
		expect(names).not.toContain('return');
		expect(names).not.toContain('break');
		// only the class and the real method are extracted
		expect(names).toEqual(['Flow', 'check']);
	});

	test('symbols are sorted by line then name', () => {
		write(
			'Sorted.java',
			`public class Zeta {}
public class Alpha {}
public void beta() {}
public void alpha() {}
`,
		);

		const symbolsList = extractJavaSymbols('Sorted.java', root);
		// line order wins: Zeta(1), Alpha(2), beta(3), alpha(4)
		expect(symbolsList.map((s) => s.name)).toEqual([
			'Zeta',
			'Alpha',
			'beta',
			'alpha',
		]);
	});

	test('empty and missing files return no symbols', () => {
		write('Empty.java', '');
		expect(extractJavaSymbols('Empty.java', root)).toEqual([]);
		expect(extractJavaSymbols('Missing.java', root)).toEqual([]);
	});

	test('adversarial repeated-modifier input does not hang extraction (ReDoS regression)', () => {
		// The method-declaration modifier group is bounded to {0,6}; an
		// unbounded star would be quadratic on repeated modifier keywords.
		const adversarial = 'public '.repeat(500) + 'void foo() {}';
		write('Adversarial.java', adversarial);

		const start = performance.now();
		const symbolsList = extractJavaSymbols('Adversarial.java', root);
		const elapsed = performance.now() - start;

		// Extraction must complete well under a generous wall-clock bound.
		expect(elapsed).toBeLessThan(1000);
		// The trailing real declaration is still extracted.
		expect(symbolsList).toContainEqual(
			expect.objectContaining({ name: 'foo', kind: 'method' }),
		);
	});

	test('legitimate multi-modifier method declarations (up to 6) still extract', () => {
		write(
			'Modifiers.java',
			`public static final synchronized void a() {}
public abstract void b() {}
private static native void c() {}
protected final strictfp void d() {}
public static synchronized final native void e() {}
public static final synchronized native abstract void f() {}
`,
		);

		const symbolsList = extractJavaSymbols('Modifiers.java', root);
		const names = symbolsList.map((s) => s.name);

		expect(names).toContain('a');
		expect(names).toContain('b');
		expect(names).toContain('c');
		expect(names).toContain('d');
		expect(names).toContain('e');
		// 6 modifiers — the {0,6} bound must not break this
		expect(names).toContain('f');
	});
});

describe('symbols tool — java routing (DS-3)', () => {
	test('the routing switch dispatches a .java file to extractJavaSymbols', async () => {
		write(
			'App.java',
			`public class App {
    public void run() {}
    private void hidden() {}
}
`,
		);

		const result = await symbols.execute({ file: 'App.java' }, {
			directory: root,
		} as any);
		const parsed = JSON.parse(result as string);

		expect(parsed.error).toBeUndefined();
		expect(parsed.file).toBe('App.java');
		// exported-only default: only public symbols survive
		expect(parsed.symbols.map((s: any) => s.name)).toEqual(['App', 'run']);
		expect(parsed.symbols.find((s: any) => s.name === 'App')?.kind).toBe(
			'class',
		);
	});

	test('exported_only=false returns package-private/private java symbols too', async () => {
		write(
			'App.java',
			`public class App {
    public void run() {}
    private void hidden() {}
}
`,
		);

		const result = await symbols.execute(
			{ file: 'App.java', exported_only: false },
			{ directory: root } as any,
		);
		const parsed = JSON.parse(result as string);

		expect(parsed.symbols.map((s: any) => s.name)).toEqual([
			'App',
			'run',
			'hidden',
		]);
	});

	test('unsupported extension error lists .java among supported extensions', async () => {
		write('Main.kt', 'fun main() {}');

		const result = await symbols.execute({ file: 'Main.kt' }, {
			directory: root,
		} as any);
		const parsed = JSON.parse(result as string);

		expect(parsed.error).toContain('Unsupported file extension');
		expect(parsed.error).toContain('.java');
	});
});
