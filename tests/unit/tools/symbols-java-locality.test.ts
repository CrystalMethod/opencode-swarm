import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractJavaSymbols } from '../../../src/tools/symbols';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// Split out of symbols-java-nested-type-recognition.test.ts to stay under
// the FR-006 500-line cap. Covers the depth-scoped type stack's own
// correctness under deeper nesting, and the export-LOCALITY semantics added
// on top of it: a type declared inside a method/block body (a local class,
// interface, enum, or record) — and all of its members — must never be
// reported as `exported: true`, regardless of an explicit `public` modifier,
// matching real Java visibility rules. The critic closeout gate found this
// gap, then found a regression in the first fix (locality computed from the
// wrong line-depth value on a multi-line-annotation continuation line).

let root: string;

function write(rel: string, content: string): void {
	const full = path.join(root, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, 'utf-8');
}

beforeEach(() => {
	root = canonicalMkdtemp('symbols-java-locality-');
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe('symbols tool — java extractor nesting depth and export locality (DS-3)', () => {
	test('scopes members correctly three levels deep for a class nested inside a class nested inside a class', () => {
		// Coverage gap check (Stage B test_engineer pass): every existing
		// nested-type fixture goes exactly two levels deep (Outer > one
		// nested type). The type-stack push/pop logic is written generically
		// against depthBeforeLine, not against a fixed nesting count, but
		// nothing exercised a THIRD level — which is exactly where an
		// off-by-one in the pop condition (`top.depth > depth`) or the
		// pushed depth (`depthBeforeLine + preNet + 1`) would first surface,
		// since a two-level fixture can't distinguish "pops one level" from
		// "pops all the way to the bottom".
		write(
			'TripleNest.java',
			`public class Outer {
    static class Middle {
        static class Inner {
            void innerMethod() {}
        }
        void middleMethod() {}
    }
    void outerMethod() {}
}
`,
		);

		const symbolsList = extractJavaSymbols('TripleNest.java', root);

		expect(symbolsList).toContainEqual(
			expect.objectContaining({ name: 'Outer', kind: 'class' }),
		);
		expect(symbolsList).toContainEqual(
			expect.objectContaining({ name: 'Middle', kind: 'class' }),
		);
		expect(symbolsList).toContainEqual(
			expect.objectContaining({ name: 'Inner', kind: 'class' }),
		);
		// The innermost method must be attributed to the type stack's top
		// (Inner), not silently dropped or misattributed to Middle/Outer —
		// there is exactly one 'innerMethod' declaration in the source, so
		// duplication or loss both show up as a wrong count here.
		expect(
			symbolsList.filter(
				(s) => s.name === 'innerMethod' && s.kind === 'method',
			),
		).toHaveLength(1);
		// middleMethod sits back at Middle's own member depth, one level
		// shallower than Inner — only reachable if the pop-on-Inner's-close
		// correctly unwinds exactly one stack frame, not zero or two.
		expect(
			symbolsList.filter(
				(s) => s.name === 'middleMethod' && s.kind === 'method',
			),
		).toHaveLength(1);
		// outerMethod sits at Outer's own member depth, two levels shallower
		// than Inner — only reachable if depth unwinds all the way back
		// through both nested frames rather than getting stuck.
		expect(
			symbolsList.filter(
				(s) => s.name === 'outerMethod' && s.kind === 'method',
			),
		).toHaveLength(1);
	});

	test('a local class and its public members are never exported, even though the local class is correctly recognized (critic closeout finding)', () => {
		// Regression: recognizing a local class (declared inside a method
		// body) as its own type on the depth-scoped stack was necessary but
		// not sufficient — its `public` members were still marked
		// `exported: true`, because nothing distinguished "member of a
		// properly-nested type" from "member of a type that only exists
		// inside a method body". In real Java, `public` on a local class or
		// its members has no additional visibility effect: a local class is
		// never part of the enclosing class's public API. Without this fix,
		// a multi-line local class with public methods leaked those methods
		// into the tool's DEFAULT (`exported_only: true`) output as if they
		// were genuine top-level API.
		write(
			'Svc.java',
			`public class Svc {
    public void run() {
        class Helper {
            public void assist() {}
            public int count() { return 1; }
        }
        Helper h = new Helper();
        h.assist();
    }
}
`,
		);

		const symbolsList = extractJavaSymbols('Svc.java', root);
		const exportedNames = symbolsList
			.filter((s) => s.exported)
			.map((s) => s.name);

		// The default (exported_only) view must show only the real public
		// API — the outer class and its own method — never the local
		// class or its members.
		expect(exportedNames).toEqual(['Svc', 'run']);
		expect(symbolsList).toContainEqual(
			expect.objectContaining({
				name: 'Helper',
				kind: 'class',
				exported: false,
			}),
		);
		expect(symbolsList).toContainEqual(
			expect.objectContaining({
				name: 'assist',
				kind: 'method',
				exported: false,
			}),
		);
		expect(symbolsList).toContainEqual(
			expect.objectContaining({
				name: 'count',
				kind: 'method',
				exported: false,
			}),
		);
	});

	test('a real member class declared on a multi-line-annotation continuation line is still exported (critic round 2 regression)', () => {
		// Regression introduced by the local-class fix above: locality was
		// computed from the raw `depthBeforeLine`, but a continuation line
		// that closes a multi-line annotation's argument list before the
		// modifiers (e.g. `}) public static class Foo {`) has
		// `depthBeforeLine` one level HIGHER than the type's own true
		// declaration depth — without folding in `preNet` the same way the
		// push depth already does, every such type (and all of its
		// members) was misclassified as local and force-unexported, even
		// though it's a genuine member class this same PR's earlier rounds
		// specifically added support for recognizing.
		write(
			'Outer2.java',
			`public class Outer2 {
    @JsonSubTypes({
        @JsonSubTypes.Type(Foo.class)
    }) public static class Continuation {
        public void continuationM() {}
    }
}
`,
		);

		const symbolsList = extractJavaSymbols('Outer2.java', root);

		expect(symbolsList).toContainEqual(
			expect.objectContaining({
				name: 'Continuation',
				kind: 'class',
				exported: true,
			}),
		);
		expect(symbolsList).toContainEqual(
			expect.objectContaining({
				name: 'continuationM',
				kind: 'method',
				exported: true,
			}),
		);
	});

	test('a local class declared on the same line as its enclosing method’s opening brace is still never exported', () => {
		// Same defect class as the local-class-leak fix, different line
		// layout: the local type's own declaration starts on the SAME
		// physical line as the method body's opening `{`, rather than on a
		// line of its own.
		write(
			'Svc.java',
			`public class Svc {
    public void run() { class Helper {
        public void assist() {}
    } }
}
`,
		);

		const symbolsList = extractJavaSymbols('Svc.java', root);

		expect(symbolsList).toContainEqual(
			expect.objectContaining({
				name: 'Helper',
				kind: 'class',
				exported: false,
			}),
		);
		expect(symbolsList).toContainEqual(
			expect.objectContaining({
				name: 'assist',
				kind: 'method',
				exported: false,
			}),
		);
	});
});
