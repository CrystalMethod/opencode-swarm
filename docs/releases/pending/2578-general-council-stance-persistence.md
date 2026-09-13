# General Council stance persistence (#2578)

- General Council synthesis now parses the documented Round 2 stance grammar
  (MAINTAIN / CONCEDE / NUANCE as the first word of a paragraph, exactly as the
  council prompts define it) instead of matching the word "concede" anywhere in
  a member response. A maintained disagreement stays in the synthesis when a
  member writes "MAINTAIN — I do not concede…": the negated prose mention is no
  longer treated as a concession. Only a paragraph-leading CONCEDE by a
  disputant, on the matched topic, resolves a disagreement.
- Consensus clustering is now stance-aware. A member with an explicit contrary
  stance — a structured claim (`oppose` or `alternative`) OR membership in any
  detected disagreement when the member holds no well-formed support claim —
  is treated as disagreement evidence and excluded from consensus points, so a
  contrary position can no longer be emitted as a consensus point just because
  its wording lexically resembles the position it opposes, even when the
  dissenter supplied no typed claims. This exclusion is deliberately
  conservative: it applies to the member's whole contribution (a member holding
  agreeing positions alongside one contrary claim is also excluded), and
  excluded members still count toward the consensus threshold denominator —
  consensus may be under-reported, never falsely reported. A dissenter missed
  by every detection pass (no typed claims, no marker phrase, high lexical
  overlap under negation) is still indistinguishable from a supporter and may
  reach consensus; detection improvements there are tracked as a follow-up.
- Markdown-decorated stance declarations parse correctly: leading blockquote,
  heading, and list markers are tolerated, and emphasis wrapping or hyphen
  joins around the keyword no longer hide a declaration.
- The paragraph-leading stance parser lives solely in
  `src/council/general-council-service.ts` (`extractLeadingStanceDeclarations`)
  and is the single owner of that grammar; no duplicate parser was added
  anywhere else.
