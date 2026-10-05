## knowledge_archive quarantine reports policy denials truthfully

`knowledge_archive` with `mode:'quarantine'` used to report an unconditional
`{success:true, status:'quarantined'}` even when the cohort-safety policy
DENIED the quarantine (or the entry vanished before the locked read): the
callee `quarantineEntry` returned `Promise<void>` and silently no-oped, and
the tool discarded the outcome. The architect was told a suspect entry was
neutralized while it stayed active in `knowledge.jsonl` and kept injecting
into every session sharing a linked cohort store. In a linked cohort the
denial is deterministic for cross-owned entries (`evidenceScope:'cohort-wide'`
is non-authorizing since #2031), so every non-owner quarantine returned a
false success — including legacy producer-less entries mass-produced by
`/swarm link` family migration.

`quarantineEntry` now returns a discriminated `QuarantineEntryOutcome`
(`quarantined` / `denied` with `basis`+`detail` / `not_found` /
`invalid_input`), and the tool maps each outcome through a shared
`mapCurationDenial` helper that the archive/purge denial path also uses, so
the three modes share one result contract and cannot drift apart again.
Authorized quarantine results are unchanged; the persisted curation proposal
remains the operator-side audit for denials.

Issue: #2950 (Workstream J, slot J-4; frontier-audit finding
`t1-src-tools-6/t1s6-r1-S-02`, dual review `reviews/dual-high-16.md`).
