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
});
