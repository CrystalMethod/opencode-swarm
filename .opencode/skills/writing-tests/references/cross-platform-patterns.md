# Cross-Platform Test Patterns and Requirements

## Cross-Platform Requirements

> **See also**: [Cross-Platform Test Patterns](#cross-platform-test-patterns) above for detailed
> guidance on mock keys, symlink behavior, temp directories, and line endings.

All tests must pass on Linux, macOS, and Windows unless explicitly gated with:
```typescript
const isWindows = process.platform === 'win32';
if (isWindows) test.skip('reason', () => {});
```

### Path handling
- Use `path.join()` or `path.resolve()`, never string concatenation with `/`.
- Temp directories: use `os.tmpdir()`, not hardcoded `/tmp`.
- File comparisons: normalize paths before comparing (`path.resolve(a) === path.resolve(b)`).

### Process spawning
- Use `.cmd` extension on Windows for npm/bun binaries: `process.platform === 'win32' ? 'bun.cmd' : 'bun'`.
- Use array-form `spawn`/`spawnSync`, never shell string commands.

### macOS rename-visibility race (write-then-read atomic files)

On macOS/APFS, `fs.renameSync` can complete before the data is visible to
subsequent reads. Tests that write-then-read atomic files may fail on
`macos-latest` but pass on `ubuntu-latest` and `windows-latest`.

**Symptom:** Test fails only on macOS with `result === null` or
`result === undefined` immediately after a write that should have made the
file visible.

**Root cause:** macOS filesystem updates the directory entry asynchronously
after `fs.renameSync`. Immediately-following reads may see ENOENT or stale
data.

**Fix — three layers (use all three for production code):**

**Layer 1: Use `bunWrite` for atomic writes.** The `bunWrite` function in
`src/utils/bun-compat.ts` already handles temp file creation, fsync,
atomic rename, and parent directory fsync correctly across platforms.
Do NOT reimplement this pattern.

**Layer 2: Add ENOENT retry in the read path.** Wrap `validateSwarmPath` and
the file read in a try/catch with a bounded retry loop for ENOENT:

```typescript
// CORRECT — retry on ENOENT only (not other errors), bounded
const maxAttempts = 5;
const retryDelayMs = 10;
for (let attempt = 0; attempt < maxAttempts; attempt++) {
  try {
    const resolvedPath = _internals.validateSwarmPath(directory, filename);
    const file = bunFile(resolvedPath);
    const content = await file.text();
    return content;
  } catch (err) {
    const isNotFound = (err as NodeJS.ErrnoException)?.code === 'ENOENT';
    if (!isNotFound || attempt === maxAttempts - 1) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
}
return null;
```

CRITICAL: `validateSwarmPath` must be INSIDE the try block so that throws
(for path traversal attempts) are caught and return null. Security tests
expect `readSwarmFileAsync` to return null for traversal attempts.

**Layer 3: Don't add arbitrary delays.** `setTimeout` should be bounded
(5-10ms, max 5 attempts). Do not add `await new Promise(r => setTimeout(r, 100))`
"just in case" — that's a code smell. The retry loop handles it.

See [`.opencode/skills/engineering-conventions/SKILL.md`](../engineering-conventions/SKILL.md)
for the evidence file flow that triggers this retry pattern in QA gates.

### Node FileHandle API

Node's `FileHandle` uses `.sync()`, NOT `.fsync()`:

```typescript
// CORRECT
const fd = await fsPromises.open(dir, 'r');
try {
  await fd.sync();
} finally {
  await fd.close();
}

// WRONG — TypeScript error: Property 'fsync' does not exist on type 'FileHandle'
const fd = await fsPromises.open(dir, 'r');
try {
  await fd.fsync();
} finally {
  await fd.close();
}
```

## Cross-Platform Test Patterns

Tests run on all three CI platforms (ubuntu, macos, windows). Path and filesystem behavior
differs between them. Follow these patterns to prevent platform-specific failures:

### Mock keys with filesystem paths

**Never hardcode Unix-format paths as mock keys.** On Windows, `path.resolve('/dir', 'file')`
produces drive-letter-prefixed paths like `D:\dir\file`, not `/dir/file`. A mock that checks
for `/dir/file` will silently never match, causing the test to behave differently on Windows.

**Use `path.resolve()` to construct mock keys the same way the source code does:**

```typescript
// ❌ WRONG — fails on Windows (mock expects '/safe/dir/linked.ts',
//    but path.resolve('/safe/dir', 'linked.ts') = 'D:\safe\dir\linked.ts')
mockRealpathSync.mockImplementation((inputPath: string) => {
  if (inputPath === '/safe/dir') return '/safe/dir';
  if (inputPath === '/safe/dir/linked.ts') return '/outside/linked.ts';
  return inputPath;
});

// ✅ CORRECT — path.resolve produces matching keys on all platforms
const mockDir = path.resolve('/safe/dir');
const linkedResolved = path.resolve(mockDir, 'linked.ts');
const outsideResolved = path.resolve('/outside/linked.ts');

// mockRealpathSync is a mock() function (bun:test) — see mocking patterns above
mockRealpathSync.mockImplementation((inputPath: string) => {
  if (inputPath === mockDir) return mockDir;
  if (inputPath === linkedResolved) return outsideResolved;
  return inputPath;
});
```

### Symlink behavior differences

- On Windows, `fs.symlinkSync` for directories creates **junctions** by default, which
  resolve differently than POSIX symlinks. Junction creation may require administrator
  elevation on older Node.js versions.
- `fs.realpathSync` on a broken symlink throws `ENOENT` on POSIX but may throw
  `EINVAL` on Windows, depending on symlink type.
- Use `test.skipIf(process.platform === 'win32')` for tests that directly manipulate
  filesystem symlinks, unless the test's purpose is explicitly to verify cross-platform
  symlink behavior.

### Temporary directory patterns

- Use `os.tmpdir()` + `path.join()` for temp paths. **Never** hardcode `/tmp` or `C:\`.
- Wrap `mkdtempSync` in `realpathSync` if the result is `chdir`'d on macOS (temp
  dirs are often symlinked to `/private/var/...`).
- Clean up temp dirs in `afterEach` or `afterAll` with a bounded helper that
  verifies the resolved cleanup target is a child of `os.tmpdir()` before
  calling recursive `rm`. Reuse `tests/helpers/safe-test-dir.ts` when possible.
  Do not call recursive `rm` on a computed path unless the helper has rejected
  empty strings, `os.tmpdir()` itself, and paths outside the temp root.

### Platform-specific environment variable redirection

When tests redirect `process.env.HOME` to isolate path-resolver-dependent code
(functions like `resolveHiveKnowledgePath`, `resolveSwarmKnowledgePath`, or any
function that reads `os.homedir()` / platform env vars), they MUST redirect ALL
platform-specific env vars, not just `HOME`. A partial redirect silently falls
back to the real user profile on some platforms, causing tests to read/write
actual user data instead of the isolated temp directory.

Per-platform requirements:

- **Linux**: redirect `HOME`, `XDG_CONFIG_HOME`, and `XDG_DATA_HOME`.
- **macOS**: redirect `HOME` (macOS resolves `~/Library/Application Support` from
  the home directory).
- **Windows**: redirect `HOME`, `LOCALAPPDATA`, AND `APPDATA`. Windows path
  resolvers read `LOCALAPPDATA` and `APPDATA`, neither of which is derived from
  `HOME`. Redirecting only `HOME` silently fails on Windows, causing tests to
  touch the real `%LOCALAPPDATA%` and `%APPDATA%` trees.

> **⚠️ Bun caches `os.homedir()` on first call.** If a module calls `os.homedir()`
> before the test sets `process.env.HOME`, the cached value persists for the
> lifetime of the process and later env changes are silently ignored. Set
> `process.env.HOME` (and other redirected vars) **before** importing any module
> that calls `os.homedir()`. The source code documents this at
> `src/hooks/knowledge-store.ts`: "Bun caches os.homedir(), so changing $HOME
> after first call is ignored."

Use per-variable save/restore rather than saving and replacing the entire
`process.env` object — the latter discards process-level env state and can
interfere with other test infrastructure:

```typescript
import { beforeEach, afterEach } from 'bun:test';
import os from 'node:os';
import path from 'node:path';

const saved = {
  HOME: process.env.HOME,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  APPDATA: process.env.APPDATA,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
};

beforeEach(() => {
  const isolatedDir = path.join(os.tmpdir(), 'test-home');
  process.env.HOME = isolatedDir;
  process.env.LOCALAPPDATA = isolatedDir;
  process.env.APPDATA = isolatedDir;
  process.env.XDG_CONFIG_HOME = isolatedDir;
  process.env.XDG_DATA_HOME = isolatedDir;
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
```

For cross-file isolation (tests that must survive across multiple files in the
same process, e.g. batch steps), use `beforeAll` / `afterAll` with the same
per-var save/restore pattern. Never mutate `process.env` without restoring it in
a matching teardown hook.

**Preferred approach:** Use `createIsolatedTestEnv()` from
`tests/helpers/isolated-test-env.ts`. It handles `XDG_CONFIG_HOME`, `APPDATA`,
`LOCALAPPDATA`, and `HOME` with correct per-variable save/restore and returns a
cleanup function that removes the temp directory. Use this helper unless your
test has specific requirements it doesn't cover.

### Line ending normalization

Git on Windows converts LF to CRLF by default. Tests that compare file contents
byte-by-byte against expected strings must normalize line endings:

```typescript
const actual = readFileSync(path, 'utf-8').replace(/\r\n/g, '\n');
```
