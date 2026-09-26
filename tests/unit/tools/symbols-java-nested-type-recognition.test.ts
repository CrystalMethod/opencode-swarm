import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractJavaSymbols } from '../../../src/tools/symbols';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// Split out of symbols-java-declaration-edge-cases.test.ts to stay under the
// FR-006 500-line cap. Covers nested-type RECOGNITION regressions found
// across four Stage B swarm-pr-review rounds: once member matching became
// brace-depth-scoped against a type stack, any type declaration the
// type-decl regex failed to recognize meant ALL of its members were
// silently dropped, not merely left unlabeled as before depth scoping
// existed. Each round found a different real-world prefix shape the
// matcher missed (array/generic/qualified return types, annotation
// placement, strictfp, doubly-nested annotation args, a multi-line
// annotation continuation line, the `record` contextual keyword, a
// wrapped record header) plus the depth-stack's own correctness under
// deeper nesting.

let root: string;

function write(rel: string, content: string): void {
	const full = path.join(root, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, 'utf-8');
}

beforeEach(() => {
	root = canonicalMkdtemp('symbols-java-nested-');
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe('symbols tool — java extractor nested-type recognition (DS-3)', () => {
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

	test('recognizes strictfp and nested-parenthesis annotations on a nested type, so its members are not dropped by depth scoping (Stage B re-check finding)', () => {
		// Regression: the type-decl regex didn't include `strictfp` in its
		// modifier alternation, and the annotation prefix only allowed a
		// single (non-nested) parenthesized argument list — so a nested
		// type declared as `public static strictfp class Calc` or
		// `@JsonTypeInfo(use = @Id(NAME)) public static class Dto` was
		// never recognized as a type at all. Once brace-depth scoping was
		// added for constructor/member detection, an unrecognized nested
		// type meant its members sat one level "too deep" relative to the
		// nearest RECOGNIZED enclosing type and were silently dropped
		// entirely, not merely left unlabeled as before.
		write(
			'Outer.java',
			`public class Outer {
    public static strictfp class Calc {
        public double add(double a, double b) { return a + b; }
    }
    @JsonTypeInfo(use = @Id(NAME)) public static class Dto {
        public String getName() { return null; }
    }
    public void outerM() {}
}
`,
		);

		const symbolsList = extractJavaSymbols('Outer.java', root);
		const names = symbolsList.map((s) => s.name);

		expect(names).toContain('Outer');
		expect(names).toContain('Calc');
		expect(names).toContain('add');
		expect(names).toContain('Dto');
		expect(names).toContain('getName');
		expect(names).toContain('outerM');
	});

	test('recognizes nested types regardless of prefix shape: annotation after a modifier, doubly-nested annotation args, and a continuation line closing a multi-line annotation (Stage B round 3 finding)', () => {
		// Regression: the type-decl regex was ANCHORED on a fixed
		// annotation-then-modifier prefix shape. Any real prefix shape that
		// didn't fit — an annotation appearing AFTER a modifier (legal
		// Java), two levels of nested annotation-argument parens, or a
		// continuation line where the modifiers follow a multi-line
		// annotation's closing `)` — meant the whole type declaration went
		// unrecognized, and (once member matching became depth-scoped
		// against the type stack) every member of that type was then
		// silently dropped too. Fixed by matching on the KEYWORD alone and
		// accounting for whatever precedes it (`pre`) via its own net
		// brace count, independent of prefix shape.
		write(
			'Outer2.java',
			`public class Outer2 {
    public @Deprecated static class AfterModifier {
        void afterModifierM() {}
    }
    @A(x = @B(y = @C(1))) public static class DoublyNested {
        void doublyNestedM() {}
    }
    @JsonSubTypes({
        @JsonSubTypes.Type(Foo.class)
    }) public static class Continuation {
        void continuationM() {}
    }
}
`,
		);

		const symbolsList = extractJavaSymbols('Outer2.java', root);
		const names = symbolsList.map((s) => s.name);

		expect(names).toContain('AfterModifier');
		expect(names).toContain('afterModifierM');
		expect(names).toContain('DoublyNested');
		expect(names).toContain('doublyNestedM');
		expect(names).toContain('Continuation');
		expect(names).toContain('continuationM');
	});

	test('does not misidentify the contextual keyword "record" as a type declaration outside a real record header', () => {
		// `record` is a contextual keyword in Java — it can still be used as
		// an identifier (a variable/parameter/method name). Only a real
		// record header (`record Name(...)` or `record Name<T>(...)`) is a
		// type declaration.
		write(
			'RecordGuard.java',
			`public class RecordGuard {
    void m(Object record) {
        if (record instanceof String) {
            record.toString();
        }
        String s = record.toString();
    }
    record Point(int x, int y) {}
}
`,
		);

		const symbolsList = extractJavaSymbols('RecordGuard.java', root);

		expect(symbolsList).toContainEqual(
			expect.objectContaining({ name: 'Point', kind: 'class' }),
		);
		expect(symbolsList).not.toContainEqual(
			expect.objectContaining({ name: 'instanceof' }),
		);
		expect(symbolsList).not.toContainEqual(
			expect.objectContaining({ name: 'toString' }),
		);
	});

	test('does not misidentify a qualified-name access like Foo.class as a type declaration', () => {
		write(
			'DotClass.java',
			`public class DotClass {
    void m() {
        Class<?> c = Foo.class;
    }
}
`,
		);

		const symbolsList = extractJavaSymbols('DotClass.java', root);
		const names = symbolsList.map((s) => s.name);

		expect(names).not.toContain('class');
		expect(names).toContain('DotClass');
	});

	test('recognizes a local class declared inside a method body as its own type, scoping its members correctly', () => {
		write(
			'LocalClass.java',
			`public class LocalClass {
    void outerM() {
        class Local {
            void localM() {}
        }
    }
}
`,
		);

		const symbolsList = extractJavaSymbols('LocalClass.java', root);
		const names = symbolsList.map((s) => s.name);

		expect(names).toContain('Local');
		expect(names).toContain('localM');
		expect(names).toContain('outerM');
	});

	test('recognizes a record whose component list is wrapped onto the next line (Stage B round 4 finding)', () => {
		// Regression: the record branch's lookahead only accepted an
		// immediately-following `(` or `<` on the SAME line, so a record
		// header wrapped by a formatter (component list on the next line)
		// was not recognized as a type declaration at all — and, same as
		// every other unrecognized-type case, all of its members were then
		// silently dropped too.
		write(
			'WrappedRecord.java',
			`public class Outer3 {
    public record Pt
        (int x, int y) {
        public int sum() { return x + y; }
    }
}
`,
		);

		const symbolsList = extractJavaSymbols('WrappedRecord.java', root);
		const names = symbolsList.map((s) => s.name);

		expect(names).toContain('Pt');
		expect(names).toContain('sum');
	});
});
