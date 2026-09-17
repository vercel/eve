---
name: investigate
description: Investigate a specific issue report with strict, evidence-driven diagnosis.
---

# Investigate

Determine unambiguously what the report means from the system's perspective. First establish whether it is real and reproducible. If not, pause and report that result.

Start at the observed effect and identify the code paths directly responsible. Climb one layer at a time across call frames, processes, network hops, and persistence boundaries. Go only as wide and deep as the evidence requires.

Keep an explicit hypothesis at every branch and try to disprove it. Prefer the simplest explanation that accounts for all observed evidence. Do not jump to solutions before diagnosis.

## Standards

- Resolve every cited call frame and reference.
- Distinguish observations, inferences, and unknowns.
- Map relevant dependencies and identify other reports or users affected by the same mechanism.
- Question assumptions about timing, state, identity, retries, and execution boundaries.
- Stop when required evidence is unavailable rather than filling gaps with guesses.

## Questions for every hypothesis

- How can this be disproved?
- Is there a simpler or more likely explanation?
- Which source references remain unresolved?
- Do the surrounding code and runtime state support the conclusion?
- Does this explain both why the behavior occurs and why it began now?

Return compact but complete evidence, the diagnosed mechanism, a decision tree when useful, and the smallest prognosis justified by the evidence.
