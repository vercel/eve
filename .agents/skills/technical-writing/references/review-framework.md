# Reviewing eve documentation

Run separate passes. Fix blockers and major issues before style nits.

## Pass 1: Purpose and structure

- Does the page have one primary job?
- Does the introduction lead with the outcome or definition?
- Does the heading order match the reader's workflow?
- Does the content belong on this page rather than a new page?

## Pass 2: Technical accuracy

- Do commands and flags match current CLI help or implementation?
- Do API names, imports, defaults, and examples match current public source and tests?
- Are limitations explicit and current?
- Does any statement describe unmerged or proposed behavior as shipped?
- For docs-only work, is each new behavior present in the latest public release rather than only on the current branch?
- Do platform claims have an authoritative owner or source?

Treat a wrong command, nonexistent API, unsafe instruction, or false guarantee as a blocker.

## Pass 3: Completeness

- Can the reader complete the supported happy path?
- Are prerequisites and environment assumptions clear?
- Are repeated real-world failure modes covered?
- Does troubleshooting tell the reader what to inspect next?
- Are product gaps separated from docs guidance?

## Pass 4: Style and retrieval

- Is `eve` lowercase?
- Are terms consistent with code and CLI output?
- Does each section lead with its key fact?
- Are headings descriptive enough to work as search results?
- Is critical information present locally rather than only behind links?
- Are sentences direct, active, and free of promotional or robotic phrasing?
- Did the edit preserve supported meaning, nuance, uncertainty, and strong existing prose?
- Are stock rhetorical patterns, filler, inflated claims, and mechanical rhythm removed where they add no value?

## Pass 5: Diff discipline

- Does every changed sentence fix an accuracy, usability, structure, or style problem?
- Did the edit preserve unrelated working content and anchors?
- Did it create contradictions elsewhere?
- Are all new files necessary?

Leave clear, correct prose unchanged.
