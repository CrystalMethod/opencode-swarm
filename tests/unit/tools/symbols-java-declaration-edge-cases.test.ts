import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractJavaSymbols } from '../../../src/tools/symbols';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// Split out of symbols-java.test.ts to stay under the FR-006 500-line cap.
// Covers declaration-edge-case regressions found during swarm-pr-review
// re-verification: nested/indented types, else/do statement exclusion, the
// type-branch modifier-slice regression, and comment/text-block masking.

let root: string;

function write(rel: string, content: string): void {
	const full = path.join(root, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, 'utf-8');
}

beforeEach(() => {
	root = canonicalMkdtemp('symbols-java-edge-');
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe('symbols tool — java extractor declaration edge cases (DS-3)', () => {
	test('extracts nested/indented type declarations and their constructors', () => {
		// Regression: the type-declaration regex had no leading `\s*`, so an
		// indented nested class/enum was never matched at all — and because
		// `lastTypeName` was never updated for it, the nested type's own
		// (package-private) constructor was silently dropped too.
		write(
			'Outer.java',
			`public class Outer {
    Outer() {}
    static class Builder {
        Builder() {}
        public Builder name(String n) { return this; }
    }
    private static final class Inner {
        Inner() {}
    }
    public enum Color {
        RED, GREEN;
        Color() {}
    }
}
`,
		);

		const symbolsList = extractJavaSymbols('Outer.java', root);
		const names = symbolsList.map((s) => s.name);

		expect(names).toContain('Outer');
		expect(symbolsList).toContainEqual(
			expect.objectContaining({ name: 'Builder', kind: 'class' }),
		);
		expect(symbolsList).toContainEqual(
			expect.objectContaining({ name: 'Builder', kind: 'method' }),
		);
		expect(symbolsList).toContainEqual(
			expect.objectContaining({ name: 'Inner', kind: 'class' }),
		);
		expect(symbolsList).toContainEqual(
			expect.objectContaining({ name: 'Inner', kind: 'method' }),
		);
		expect(symbolsList).toContainEqual(
			expect.objectContaining({ name: 'Color', kind: 'enum' }),
		);
		expect(symbolsList).toContainEqual(
			expect.objectContaining({ name: 'Color', kind: 'method' }),
		);
		expect(names).toContain('name');
	});

	test('recognizes an outer package-private constructor declared AFTER a nested type closes', () => {
		// Regression: tracking only the single most-recently-declared type
		// name (rather than every type name seen in the file) meant that
		// once a nested type's declaration line updated that single
		// tracked name, the OUTER type's own package-private constructor
		// — appearing later in the file, after the nested type closes —
		// no longer matched and was silently dropped.
		write(
			'Outer.java',
			`public class Outer {
    static class Builder {
        Builder() {}
    }
    Outer() {}
}
`,
		);

		const symbolsList = extractJavaSymbols('Outer.java', root);

		expect(symbolsList).toContainEqual(
			expect.objectContaining({ name: 'Outer', kind: 'class' }),
		);
		expect(symbolsList).toContainEqual(
			expect.objectContaining({ name: 'Builder', kind: 'class' }),
		);
		expect(symbolsList).toContainEqual(
			expect.objectContaining({ name: 'Builder', kind: 'method' }),
		);
		expect(symbolsList).toContainEqual(
			expect.objectContaining({ name: 'Outer', kind: 'method' }),
		);
	});

	test('does not misreport a call statement after else/do as a method declaration', () => {
		write(
			'Control.java',
			`public class Control {
    void run(boolean x) {
        if (x) foo();
        else bar(x);
        do baz(); while (x);
    }
}
`,
		);

		const symbolsList = extractJavaSymbols('Control.java', root);
		const names = symbolsList.map((s) => s.name);

		expect(names).not.toContain('bar');
		expect(names).not.toContain('baz');
		expect(names).toContain('run');
	});

	test('does not mark a type exported when its name merely contains a modifier keyword as a substring', () => {
		// Regression: the type branch's modifier slice used lastIndexOf,
		// which can land on an occurrence of the keyword INSIDE the type
		// name itself (e.g. "class" appears again inside "publicclass"),
		// slicing past the real keyword and letting "public" leak into the
		// modifiers text.
		write(
			'Weird.java',
			`class publicclass {}
`,
		);

		const symbolsList = extractJavaSymbols('Weird.java', root);
		const cls = symbolsList.find((s) => s.name === 'publicclass');

		expect(cls).toBeDefined();
		expect(cls?.exported).toBe(false);
	});

	test('does not extract commented-out or text-block declarations as real symbols', () => {
		write(
			'Commented.java',
			`public class Commented {
    /*
     * public void commentedOut() {}
     */
    public void real() {}

    String doc = """
        public void inTextBlock() {}
        """;
}
`,
		);

		const symbolsList = extractJavaSymbols('Commented.java', root);
		const names = symbolsList.map((s) => s.name);

		expect(names).not.toContain('commentedOut');
		expect(names).not.toContain('inTextBlock');
		expect(names).toContain('real');
	});

	test('signature field shows real source text, not the masked line', () => {
		// The matching itself must use the masked (comment/string-blanked)
		// line, but the human-readable `signature` field should still show
		// the real, unmasked source — confirms the raw/masked line arrays
		// stay correctly separated rather than the masked text leaking
		// into `signature`.
		write(
			'Sig.java',
			`public class Sig {
    public void m(String s) { String x = "public void fake() {}"; }
}
`,
		);

		const symbolsList = extractJavaSymbols('Sig.java', root);
		const method = symbolsList.find((s) => s.name === 'm');

		expect(method?.signature).toContain('"public void fake() {}"');
	});

	test('extracts array-return, nested-generic, qualified-type, and annotated declarations (swarm-pr-review closeout finding 1)', () => {
		// Regression: the return-type-token group had no array-suffix, no
		// nested-generic, no dotted-qualified-name support, and no
		// annotation-prefix skip, so every one of these everyday Java
		// shapes was silently dropped from a "first-class Java support"
		// extractor.
		write(
			'Shapes.java',
			`@Entity public class Annotated {}
public class Shapes {
    public String[] arrayReturn() { return null; }
    public Map<String, List<Integer>> nestedGeneric() { return null; }
    public java.util.List<String> qualified() { return null; }
    @Override public String toString() { return ""; }
    public static <T> List<T> genericMethod(T t) { return null; }
}
public @interface MyAnno {}
`,
		);

		const symbolsList = extractJavaSymbols('Shapes.java', root);
		const names = symbolsList.map((s) => s.name);

		expect(symbolsList).toContainEqual(
			expect.objectContaining({
				name: 'Annotated',
				kind: 'class',
				exported: true,
			}),
		);
		expect(names).toContain('arrayReturn');
		expect(names).toContain('nestedGeneric');
		expect(names).toContain('qualified');
		expect(names).toContain('toString');
		expect(names).toContain('genericMethod');
		expect(symbolsList).toContainEqual(
			expect.objectContaining({
				name: 'MyAnno',
				kind: 'interface',
				exported: true,
			}),
		);
	});

	test('does not misidentify a call statement inside a method body as a constructor (swarm-pr-review closeout finding 3)', () => {
		// Regression: constructor detection tracked "any type name seen
		// anywhere in the file" rather than brace-depth scope, so a call
		// statement inside a method body whose name happened to match a
		// declared type (e.g. `Foo(1);` inside `Foo`'s own `bar()`) was
		// misidentified as a package-private constructor.
		write(
			'CallVsCtor.java',
			`public class Foo {
    static class Helper {
        Helper() {}
    }
    Foo() {}
    void bar() {
        Foo(1);
        Helper(2);
    }
}
`,
		);

		const symbolsList = extractJavaSymbols('CallVsCtor.java', root);
		const ctorLines = symbolsList
			.filter((s) => s.kind === 'method' && s.name === 'Foo')
			.map((s) => s.line);

		// Only the real constructor at its declaration line, never the
		// call statement inside bar().
		expect(ctorLines).toEqual([5]);
		expect(symbolsList).toContainEqual(
			expect.objectContaining({ name: 'bar', kind: 'method' }),
		);
	});

	test('interface members are implicitly exported unless explicitly private; Allman brace style is supported (swarm-pr-review closeout finding 2)', () => {
		// Regression: `exported` required a literal `public` modifier, but
		// interface (and abstract) methods are implicitly public in real
		// Java and are almost never written with an explicit `public` — so
		// every interface method was reported as NOT exported by default.
		// Also exercises Allman-style braces (`{` on its own line), which
		// the brace-depth type stack must still track correctly.
		write(
			'Shape.java',
			`public interface Shape
{
    double area();
    default double perimeter() { return 0; }
    static Shape unit() { return null; }
    private double helper() { return 0; }
}
`,
		);

		const symbolsList = extractJavaSymbols('Shape.java', root);

		expect(symbolsList.find((s) => s.name === 'area')?.exported).toBe(true);
		expect(symbolsList.find((s) => s.name === 'perimeter')?.exported).toBe(
			true,
		);
		expect(symbolsList.find((s) => s.name === 'unit')?.exported).toBe(true);
		expect(symbolsList.find((s) => s.name === 'helper')?.exported).toBe(false);
	});
});
