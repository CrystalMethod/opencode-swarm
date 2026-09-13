# General Council stance persistence (#2578)

- General Council synthesis now parses the documented Round 2 stance grammar
  (MAINTAIN / CONCEDE / NUANCE as the first word of a paragraph, exactly as the
  council prompts define it) instead of matching the word "concede" anywhere in
  a member response. A maintained disagreement stays in the synthesis when a
  member writes "MAINTAIN — I do not concede…": the negated prose mention is no
  longer treated as a concession. Only a paragraph-leading CONCEDE by a
  disputant, on the matched topic, resolves a disagreement.
- Consensus clustering is now stance-aware. A member who supplied a structured
  claim with an explicit contrary stance (`oppose` or `alternative`) is treated
  as disagreement evidence and excluded from consensus points, so a contrary
  position can no longer be emitted as a consensus point just because its
  wording lexically resembles the position it opposes. Members with agreeing
  or unrelated positions are unaffected.
- The paragraph-leading stance parser lives solely in
  `src/council/general-council-service.ts` (`extractLeadingStanceDeclarations`)
  and is exported for the registered `convene_general_council` entrypoint; no
  duplicate parser was added anywhere else.
