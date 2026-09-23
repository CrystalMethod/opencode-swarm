/**
 * Shared Java extraction module.
 *
 * Owns both Java import parsing and the tree-sitter Java symbol grammar:
 * - `parseJavaImports` reconciles the two previously-duplicated import
 *   implementations:
 *   - `parseJavaFileImports` in `src/tools/repo-graph/builder.ts` (whole-file,
 *     line-anchored regex with comment/string masking)
 *   - `parseJavaImport` in `src/lang/symbol-graph.ts` (single-line regex)
 * - `JAVA_SYMBOL_GRAMMAR` is the tree-sitter Java symbol grammar (defs/imports/
 *   refs query sets) previously defined in `src/lang/symbol-graph.ts`, absorbed
 *   here so the shared module owns the Java symbol grammar.
 *
 * Import binding semantics deliberately match both predecessors so consumers of
 * either shape observe identical results:
 * - `import a.b.C;`          -> specifier `a.b.C`, named, binding `C`
 * - `import static a.b.C.m;` -> specifier `a.b.C`, named, binding `m`
 * - `import a.b.*;`          -> specifier `a.b.*`, namespace, no named binding
 * - `import static a.b.*;`   -> specifier `a.b.*`, namespace, no named binding
 *
 * The module does not perform symbol extraction itself; it only provides the
 * import parser and the symbol grammar that consumers (refactored separately)
 * use to extract symbols.
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
 * context). Single-line string/char literals, comments, and Java text-block
 * contents are masked before matching so a line-initial `import ...;` inside a
 * string literal, comment, or text block is never fabricated as a real import.
 *
 * @param rawContent - Full Java source text.
 * @returns The parsed import statements in source order.
 */
export function parseJavaImports(rawContent: string): JavaImport[] {
	const imports: JavaImport[] = [];
	const content = maskMultilineStringLiterals(
		stripComments(maskStringLiterals(rawContent)),
	);
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
	return content.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Masks the contents of single-line double-quoted string literals and
 * single-quoted char literals so an import-looking line inside a string is
 * never fabricated as a real import. Runs before `stripComments` so a string
 * containing `//` or `/*` is not corrupted by comment-stripping.
 *
 * The surrounding quotes are preserved so Java text-block delimiters (`"""`)
 * remain detectable by `maskMultilineStringLiterals`. Escaped quotes (`\"`,
 * `\'`) do not terminate the literal, and a raw newline terminates it
 * (single-line literals cannot span lines), so a quote inside a comment cannot
 * bleed across lines and mask a real import.
 */
function maskStringLiterals(content: string): string {
	let out = '';
	let inLiteral = false;
	let quote = '';
	for (let i = 0; i < content.length; i++) {
		const ch = content[i];
		if (inLiteral) {
			if (ch === '\\') {
				// Escape sequence: mask the backslash and the escaped char,
				// preserving a line-continuation newline.
				out += ' ';
				if (i + 1 < content.length) {
					const next = content[i + 1];
					out += next === '\n' ? next : ' ';
					i++;
				}
				continue;
			}
			if (ch === '\n') {
				// A single-line literal cannot span a newline.
				inLiteral = false;
				out += ch;
				continue;
			}
			if (ch === quote) {
				// Closing quote: preserve it and exit the literal.
				inLiteral = false;
				out += ch;
				continue;
			}
			out += ' ';
			continue;
		}
		if (ch === '"' || ch === "'") {
			inLiteral = true;
			quote = ch;
			out += ch; // preserve the opening quote
			continue;
		}
		out += ch;
	}
	return out;
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

/**
 * The tree-sitter query sets for a single grammar id — one defs/imports/refs
 * triple. Patterns must be verified against the shipped grammar WASMs
 * (s-expression dumps) before being added: node types and field names differ
 * from what source syntax suggests.
 */
export interface SymbolGrammar {
	/** Query patterns matching symbol definitions (functions, classes, ...). */
	defs: string;
	/** Query patterns matching import/require statements. */
	imports: string;
	/** Query patterns matching symbol references. */
	refs: string;
	/** Query patterns matching export statements. */
	exports: string;
}

/**
 * The tree-sitter Java symbol grammar.
 *
 * Absorbed from `src/lang/symbol-graph.ts` so the shared Java extraction module
 * owns the Java symbol grammar alongside import parsing. Consumers extract
 * symbols by running these query sets against a parsed Java tree.
 */
export const JAVA_SYMBOL_GRAMMAR: SymbolGrammar = {
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
