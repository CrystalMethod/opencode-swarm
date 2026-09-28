# Write-site canonicalization of attribution file paths

Per-task file-attribution records (`modifiedFilesByTask`) now store one
portable path form: repo-relative against the writer's workspace directory,
forward-slashed, and case-folded on Windows. Previously the two writers
stored different forms — raw tool-arg paths (absolute, `..`-bearing, or
case-mismatched) from foreground coder writes, and git-derived repo-relative
paths from background settlement — and every consumer had to re-derive path
semantics on its own; the review-routing consumer
(`path.join(directory, entry)` + `git show HEAD:<entry>`) misresolved
absolute entries outright.

Both attribution setters (`recordModifiedFilesForTask` /
`recordModifiedFileForTask`) now accept an optional workspace directory and
canonicalize entries through a new shared pure helper
(`canonicalAttributionPath`, `src/utils/path.ts`). Entries that cannot be
proven canonical drop silently — attribution entries are advisory: absolute
paths recorded without a workspace base, any path escaping the workspace,
relative `..`-bearing paths without a base, and entries over 4,096
characters or containing control characters. The bounded 128-task map and dedupe semantics are unchanged; the
only return-semantics change is that whitespace-only input to the singular
setter now returns false (previously only zero-length input did). Old
snapshots carrying raw absolute entries still load verbatim (the
deserializer intentionally sits outside this boundary; read-side
canonicalization keeps covering them).

The scope-warning read-side canonicalization shipped with the #2818 fix
remains as defense-in-depth, and the #2927 foreground-only attribution
boundary is untouched — the producer spellings and sites are exactly as
pinned.
