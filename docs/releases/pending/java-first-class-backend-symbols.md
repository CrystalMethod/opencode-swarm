# First-class Java backend and `.java` symbols routing

## What changed

Java is now a first-class language across the extraction stack (PR #2914):

- **`src/lang/java-extraction.ts` (new shared module):** the two previously-duplicated
  Java import parsers — `parseJavaFileImports` in `src/tools/repo-graph/builder.ts`
  (whole-file, line-anchored regex with comment/string masking) and `parseJavaImport`
  in `src/lang/symbol-graph.ts` (single-line regex) — are reconciled into one
  `parseJavaImports`. The tree-sitter `JAVA_SYMBOL_GRAMMAR` (defs/imports/refs query
  sets) is absorbed here too, so the shared module owns both Java import parsing and
  the Java symbol grammar. Import binding semantics deliberately match both
  predecessors: `import a.b.C;` → specifier `a.b.C`, binding `C`;
  `import static a.b.C.m;` → specifier `a.b.C`, binding `m`; `import a.b.*;` →
  namespace import with no named binding. Comments and Java text blocks are masked
  before matching, and the line-anchored pattern accepts leading whitespace so
  indented imports are never missed.

- **`src/lang/backends/java.ts` (new first-class `java` backend):** overrides four
  hooks on top of the registry-driven default — `extractImports` reuses the shared
  `parseJavaImports`; `selectTestFramework` prefers the Gradle wrapper `./gradlew`
  when present and otherwise falls back to the default registry-driven selection;
  `selectEntryPoints` scans the tree for `.java` files declaring
  `public static void main` (bounded: depth 8, 1000 files, skipping
  `.git`/`.gradle`/`target`/`build`/`node_modules`/`.idea`); and `selectFramework`
  detects Spring vs Servlet from `pom.xml` / `build.gradle` / `build.gradle.kts`.
  Registered in `src/lang/backends/index.ts`.

- **`symbols` tool:** `.java` is now a supported extension, routed through the new
  `extractJavaSymbols` (class/interface/enum/record declarations plus methods and
  constructors; Java reserved keywords are excluded from method names so control-flow
  lines like `if (x)` are not misreported as methods). Tool metadata now lists Java in
  the supported-language description.

## Why

Java projects previously relied on duplicated, divergent import parsers and had no
first-class backend — no Gradle-wrapper-aware test selection, no `main` entry-point
detection, no Spring/Servlet framework detection, and no `.java` symbol extraction in
the `symbols` tool. Consolidating the parsers removes the drift risk between the two
implementations and gives Java parity with the other supported languages.

## Migration

No breaking changes. The shared `parseJavaImports` preserves the binding semantics of
both predecessor parsers, so repo-graph and symbol-graph consumers observe identical
results. The new backend and `.java` routing are additive.

## Known caveats

- `extractJavaSymbols` is best-effort regex line parsing, not AST-based; `exported`
  reflects Java `public` visibility, and `record` declarations map to the `class`
  kind (there is no `record` kind in `SymbolInfo`).
- The entry-point scan is bounded (depth 8, 1000 files) and skips build/output
  directories, so a `main` class deeper than the bound or under an ignored directory
  is not reported.