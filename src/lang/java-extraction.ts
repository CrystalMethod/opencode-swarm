/**
 * Shared Java import extraction.
 *
 * Single source of truth for parsing Java `import` statements, reconciling the
 * two previously-duplicated implementations:
 * - `parseJavaFileImports` in `src/tools/repo-graph/builder.ts` (whole-file,
 *   line-anchored regex with comment/string masking)
 * - `parseJavaImport` in `src/lang/symbol-graph.ts` (single-line regex)
 *
 * Binding semantics deliberately match both predecessors so consumers of either
 * shape observe identical results:
 * - `import a.b.C;`          -> specifier `a.b.C`, named, binding `C`
 * - `import static a.b.C.m;` -> specifier `a.b.C`, named, binding `m`
 * - `import a.b.*;`          -> specifier `a.b.*`, namespace, no named binding
 * - `import static a.b.*;`   -> specifier `a.b.*`, namespace, no named binding
 *
 * The module is import-parsing-only: it does not perform symbol extraction and
 * does not depend on any tree-sitter grammar.
 */

/** A single bound name produced by a named import. */
export interface JavaImportBinding {
	/** The declaration name as it appears in the imported module. */
	imported: string;
	/** The name bound in the importing file (identical to `imported` for Java). */
	local: string;
}

/** A single parsed Java import statement. */
export interface JavaImport {
	/** The module specifier (enclosing type for a static member import). */
	specifier: string;
	/** `named` binds a single declaration; `namespace` is an on-demand `.*` import. */
	importType: 'named' | 'namespace';
	/** Bound names; empty for namespace imports. */
	bindings: JavaImportBinding[];
}

/**
 * Parse every Java `import` statement in a source file.
 *
 * Handles single, multiple, static, wildcard, and package-private imports
 * (imports appearing in a file regardless of surrounding package/access
 * context). Comments and Java text-block contents are masked before matching so
 * a line-initial `import ...;` inside a text block is never fabricated as a
 * real import.
 *
 * @param rawContent - Full Java source text.
 * @returns The parsed import statements in source order.
 */
export function parseJavaImports(rawContent: string): JavaImport[] {
	const imports: JavaImport[] = [];
	const content = maskMultilineStringLiterals(stripComments(rawContent));
	const re =
		/^[ \t]*import[ \t]+(static[ \t]+)?([A-Za-z_][\w.]*(?:\.\*)?)[ \t]*;?[ \t]*\r?$/gm;
	for (let m = re.exec(content); m !== null; m = re.exec(content)) {
		const isStatic = Boolean(m[1]);
		const raw = m[2];
		if (raw.endsWith('.*')) {
			imports.push({ specifier: raw, importType: 'namespace', bindings: [] });
			continue;
		}
		// A static single-member import names the member, so the module is the
		// enclosing type and the binding is the member.
		const imported = finalDottedSegment(raw);
		const specifier = isStatic ? raw.split('.').slice(0, -1).join('.') : raw;
		imports.push({
			specifier,
			importType: 'named',
			bindings: [{ imported, local: imported }],
		});
	}
	return imports;
}

/** Returns the final dotted segment of a path, or the path itself if undotted. */
function finalDottedSegment(path: string): string {
	const lastDot = path.lastIndexOf('.');
	return lastDot === -1 ? path : path.slice(lastDot + 1);
}

/**
 * Removes line and block comments, preserving string literals verbatim.
 * Mirrors the masking behavior of the repo-graph fallback so imports inside
 * comments are not matched.
 */
function stripComments(content: string): string {
	return content
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Masks the contents of Java text blocks (`""" ... """`) so a line-initial
 * `import ...;` inside a text block cannot be misread as a real import.
 */
function maskMultilineStringLiterals(content: string): string {
	return content.replace(/"""[\s\S]*?"""/g, (block) =>
		block.replace(/[^\n]/g, ' '),
	);
}
