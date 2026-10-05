## test_runner no longer crashes when `files` is omitted but `targets` is provided

`test_runner` had a latent crash in the `convention`, `graph`, and `impact`
scope branches. When the optional `files` argument was omitted while `targets`
was supplied, those branches dereferenced the raw `args.files!` non-null
assertion and threw `Cannot read properties of undefined (reading 'filter')`
once framework detection succeeded.

The top-of-path guard only fires when **both** `files` and `targets` are
missing, so a targets-only call passed the guard and reached the crashing
branches. The bug affected every framework — a Bun project with
`scope: 'convention'` and no `files` crashed identically. It was previously
masked in nested-Maven projects because detection returned `none` and exited
early; the nested-Maven detection fix exposed it.

### Fix

The six `args.files!` sites (four in the convention branch, one in graph, one
in impact) now use the already-defaulted `_files` array (`args.files || []`).
Behavior is now:

- **`targets` provided, `files` omitted** — returns the documented structured
  error instead of crashing:
  - `convention`: `Provided files contain no recognized source files or direct test files`
  - `graph` / `impact`: `Provided files contain no source files with recognized extensions`
- **Neither `files` nor `targets`** — the pre-existing guard error is unchanged.
- **`files` provided** — behavior is identical to before.

Three misleading comments were corrected (the guard accepts `targets` alone, so
`files` can legitimately be empty in those branches). Regression tests pin the
guard and the three scope branches (no `TypeError`, correct structured error, no
spawn) for a nested-Maven project and for a Bun project, on both the default
dispatch path and `SWARM_LANG_BACKEND=legacy` for the Bun project.

### Former caveat, since fixed

When `targets` was given without `files`, the structured error still read
"Provided files contain…", which was misleading since no files were provided.
That was fixed later in this same release cycle: targets-only calls in the
`convention`, `graph`, and `impact` scopes are now rejected up front by the
scope guard with one accurate message (see the test_runner
spawn-classification and targets-only rejection note in this release;
#3041).
