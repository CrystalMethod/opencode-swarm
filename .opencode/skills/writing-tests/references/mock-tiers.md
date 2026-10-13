# Two-Tier Mock Convention and mock.module() Export Completeness

## mock.module() Export Completeness

When using `mock.module()` (or `vi.mock()`) with Bun's test runner, the mock factory **MUST provide stubs for ALL named exports** of the target module — not just the ones your test calls. Bun validates the export set at dynamic-import time and throws `SyntaxError: Export named 'X' not found` if any export is missing.

### Why this matters

Transitive imports may reference exports your test never calls directly. For example, if your test mocks `config/schema.js` and only uses `stripKnownSwarmPrefix`, but a transitive dependency imports `PluginConfigSchema` from the same module, the mock MUST include `PluginConfigSchema` as a stub — even though your test never calls it.

When the source module gains new exports (e.g., a PR adds 50 new Zod schemas to `config/schema.ts`), ALL existing `mock.module()` calls targeting that module must be updated — even if the new exports are irrelevant to your test.

### How to verify completeness

Before finalizing a test that uses `mock.module()`:

1. List all runtime exports of the target module (type-only exports are erased at compile time and need no stub):
   ```bash
   grep -E "^export (const|function|async function|class) " src/path/to/module.ts
   ```
   **Note:** Do NOT include `type` or `interface` exports — Bun erases these at compile time and they need no runtime stub.
2. Ensure every export name has an entry in your `mock.module()` factory.
3. Stubs can be minimal:
   - Functions: `() => null` or `async () => {}`
   - Zod schemas: use a comprehensive stub that supports common methods:
     ```typescript
     const zodStub = {
       parse: (v: unknown) => v,
       safeParse: (v: unknown) => ({ success: true as const, data: v }),
       parseAsync: async (v: unknown) => v,
     };
     ```
   - Constants: appropriate zero values (`''`, `0`, `null`, `[]`, `{}`)

### Verification pattern

```typescript
// ✅ CORRECT — all exports provided, test uses only the first one
mock.module('../../../src/config/schema.js', () => ({
  // The one export your test actually uses
  stripKnownSwarmPrefix: mockStripFn,
  // Stubs for transitive import resolution (never called in test)
  PluginConfigSchema: zodStub,
  ScoringConfigSchema: zodStub,
  isKnownCanonicalRole: () => false,
  // ... all other runtime exports as stubs
}));

// ❌ WRONG — missing exports cause SyntaxError at module-load time
mock.module('../../../src/config/schema.js', () => ({
  stripKnownSwarmPrefix: mockStripFn,
  // Missing: PluginConfigSchema, ScoringConfigSchema, etc.
  // → "SyntaxError: Export named 'PluginConfigSchema' not found"
}));
```

### What IS and IS NOT test theater

Adding stubs for ESM resolution is NOT test theater — it's a Bun runtime requirement. The distinction:

| Pattern | Test theater? | Why |
|---------|--------------|-----|
| Adding `PluginConfigSchema: zodStub` so the module loads | **No** | Required for ESM resolution; stub is never called |
| Stubbing `validateDirectory` to return `true` then asserting "validation works" | **Yes** | The stub bypasses the logic you should be testing |
| Using `zodStub` in assertions: `expect(zodStub.parse(input)).toBe(input)` | **Yes** | Testing the stub, not the real code |
| Adding stubs for ALL 50 Zod schemas in config/schema.ts | **No** | All are required for transitive import resolution |

The stubs exist solely to satisfy the module loader. Test assertions must verify behavior through the real-mocked functions (the ones your test actually calls), not through the stubs.

### Files Intentionally Using File-Scoped Mocks

Some test files use top-level `mock.module` that must persist across all tests in the file. These files use `mockReset()`/`mockClear()` in `beforeEach` instead of `mock.restore()` in `afterEach`:

- `src/__tests__/preflight-phase.test.ts` — mocks `plan/manager` and `preflight-service`

## Two-Tier Mock Convention

The codebase uses a two-tier strategy for mock isolation, plus a zero-mock testing pattern:

### Tier 0: _test_exports Pure Function Testing (Zero Mocks)

When a module contains internal utility functions (formatters, normalizers, transformers) that don't need external dependencies, export them via a `_test_exports` object for direct unit testing. This avoids `mock.module` entirely and produces tests that are deterministic, fast, and immune to Bun's cross-file mock leakage:

```typescript
// In source file (src/tools/formatter.ts)
function formatEntry(entry: SomeType): string {
  // internal implementation — may use optional chaining, defaults, etc.
  return entry.score?.toFixed(2) ?? 'N/A';
}

// Public API (tool handler, command handler, etc.)
export function handleQuery(ctx: Context) {
  const entries = readData(ctx);
  return entries.map(formatEntry);
}

// Export seam for testing — only used by test files
export const _test_exports = { formatEntry };
```

```typescript
// In test file (tests/unit/tools/formatter.test.ts)
import { _test_exports } from '../../../src/tools/formatter';

const { formatEntry } = _test_exports;

describe('formatEntry', () => {
  test('handles missing score', () => {
    expect(formatEntry({ score: undefined })).toBe('N/A');
  });
  test('formats numeric score', () => {
    expect(formatEntry({ score: 0.85 })).toBe('0.85');
  });
});
```

**When to use Tier 0 vs Tier 1:**
- **Tier 0 (`_test_exports`)**: The function is a pure utility (formatter, normalizer, transformer) that doesn't call external modules. No mocking needed — test it directly.
- **Tier 1 (`_internals`)**: You need to mock a function within the same module to test the caller in isolation. The function has side effects or calls external APIs.
- **Tier 2 (`mock.module`)**: You need to mock a dependency from another module (Node built-ins, other application modules).

**Benefits of Tier 0:**
- Zero mock pollution — no `mock.module` calls, no `mock.restore()` needed
- Works in batch test runs without per-file isolation
- Type-safe (the exported object carries the real TypeScript types)
- No filesystem dependencies (no tmpDir, no chdir, no existsSync)
- Deterministic on all platforms and CI environments

### Tier 1: _internals DI Seams (Within-Module)

For mocking functions within the same module, source files export an `_internals` object that wraps key functions. Tests can replace individual functions without using `mock.module`:

```typescript
// In source file (src/services/my-service.ts)
export const _internals = {
  helperFn: () => { /* real implementation */ }
};

export function mainFn() {
  return _internals.helperFn();
}
```

```typescript
// In test file
import { _internals, mainFn } from '../../../src/services/my-service';

test('mainFn uses mocked helper', () => {
  const original = _internals.helperFn;
  _internals.helperFn = mock(() => 'mocked');
  // ... test ...
  _internals.helperFn = original; // restore
});
```

**Benefits:**
- No process-global mock pollution
- Type-safe
- Fast (no module re-parsing)
- Works in batch test runs without isolation

**Critical limitation — reference-captured functions:** `_internals` interception requires the source code to read `_internals.fn` at the call site. When a function is instead passed as a direct argument or captured in a closure at module definition time, replacing `_internals.fn` has no effect — the mock is silently ignored and the real function runs.

```typescript
// Source: readKnowledge is captured at definition time, NOT via _internals
export async function transactKnowledge(filePath: string, mutate: Fn) {
  return transactFile(filePath, readKnowledge, ...);  // direct ref, captured at definition time
}
export const _internals = { readKnowledge };  // mutating this does NOT affect the closure above

// Test — mock is silently ignored; real readKnowledge still runs
const orig = _internals.readKnowledge;
_internals.readKnowledge = mock(() => []);  // only mutates the object property
await transactKnowledge(path, mutate);      // still calls the real readKnowledge
_internals.readKnowledge = orig;
```

When `_internals` interception cannot work, verify **observable outcomes** instead: run concurrent callers and assert on final persisted state. See `tests/unit/hooks/knowledge-application.test.ts` ("two concurrent bumpCountersBatch calls") for the pattern.

### Tier 2: mock.module (Cross-Module)

When mocking dependencies from other modules (especially Node built-ins), use `mock.module` with proper cleanup:

```typescript
import * as realFs from 'node:fs/promises';

mock.module('node:fs/promises', () => ({
  ...realFs,  // MUST spread real exports
  readFile: mock(() => Promise.resolve('mocked')),
}));

afterEach(() => mock.restore());
```

**Critical rules for cross-module mocks:**
1. **Always spread real exports** for Node built-ins — other code depends on exports you don't mock
2. **Always add `afterEach(mock.restore())`** — provides best-effort cleanup
3. **Run in per-file isolation** — CI runs each file in its own process (`for f in *.test.ts; do bun --smol test "$f"; done`)

### Choosing Between Tiers

| Scenario | Pattern | Example |
|----------|---------|--------|
| Mocking a function in the same module you're testing | `_internals` seam | `src/state.ts` `_internals.loadSnapshot` |
| Mocking a Node built-in (fs, child_process, etc.) | `mock.module` + spread real | `mock.module('node:fs/promises', () => ({ ...realFs, readFile: mockFn }))` |
| Mocking another application module | `mock.module` + cleanup | `mock.module('../../../src/utils/logger', ...)` + `afterEach(mock.restore())` |
| File-scoped mock (applies to all tests in file) | `mock.module` at top level + `mockReset()` in `beforeEach` | Preflight tests with `mockLoadPlan.mockReset()` |
