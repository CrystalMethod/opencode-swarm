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
	const content = maskCommentsAndLiterals(rawContent);
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

/**
 * Masks comments (line, block), string/char literals, and Java text blocks in
 * a single left-to-right pass, so entering a comment always takes priority
 * over quote characters found inside it. This fixes a bug where a quote
 * character inside a comment (e.g. an apostrophe in `/* Foo's Inc. *\/`) was
 * previously treated as starting a string/char literal by a separate masking
 * pass that ran before comment-stripping, causing the literal-masking logic
 * to consume the comment's own closing `*\/` and corrupt subsequent
 * comment-stripping across the rest of the file.
 */
export function maskCommentsAndLiterals(content: string): string {
	let out = '';
	let i = 0;
	const n = content.length;
	while (i < n) {
		const ch = content[i];
		const next = i + 1 < n ? content[i + 1] : '';
		const next2 = i + 2 < n ? content[i + 2] : '';

		// Java text block: """ ... """
		if (ch === '"' && next === '"' && next2 === '"') {
			out += '   ';
			i += 3;
			while (i < n) {
				if (
					content[i] === '"' &&
					content[i + 1] === '"' &&
					content[i + 2] === '"'
				) {
					out += '   ';
					i += 3;
					break;
				}
				out += content[i] === '\n' ? '\n' : ' ';
				i++;
			}
			continue;
		}

		// Line comment
		if (ch === '/' && next === '/') {
			while (i < n && content[i] !== '\n') {
				out += ' ';
				i++;
			}
			continue;
		}

		// Block comment
		if (ch === '/' && next === '*') {
			out += '  ';
			i += 2;
			while (i < n) {
				if (content[i] === '*' && content[i + 1] === '/') {
					out += '  ';
					i += 2;
					break;
				}
				out += content[i] === '\n' ? '\n' : ' ';
				i++;
			}
			continue;
		}

		// String or char literal
		if (ch === '"' || ch === "'") {
			const quote = ch;
			out += ch;
			i++;
			while (i < n) {
				const c = content[i];
				if (c === '\\') {
					out += ' ';
					i++;
					if (i < n) {
						out += content[i] === '\n' ? content[i] : ' ';
						i++;
					}
					continue;
				}
				if (c === '\n') {
					// A single-line literal cannot span a newline.
					break;
				}
				if (c === quote) {
					out += c;
					i++;
					break;
				}
				out += ' ';
				i++;
			}
			continue;
		}

		out += ch;
		i++;
	}
	return out;
}

/** Returns the final dotted segment of a path, or the path itself if undotted. */
function finalDottedSegment(path: string): string {
	const lastDot = path.lastIndexOf('.');
	return lastDot === -1 ? path : path.slice(lastDot + 1);
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
