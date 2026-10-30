# Reviewing eve documentation

Run separate passes. Fix blockers and major issues before style nits.

## Pass 1: Purpose and structure

- Does the page have one primary job?
- Does the introduction lead with the outcome or definition?
- Does a feature page follow the feature page shape in content-types.md, reaching a minimal example before variants and edge cases?
- Does the heading order match the reader's workflow?
- Does the content belong on this page rather than a new page?

## Pass 2: Technical accuracy

- Do commands and flags match current CLI help or implementation?
- Do API names, imports, defaults, and examples match current public source and tests?
- Are limitations explicit and current?
- Does any statement describe unmerged or proposed behavior as shipped?
- Does any statement narrate eve's history, such as removed options, renames, or how behavior used to work?
- Does the page describe the contract rather than the mechanism, naming only exported APIs, documented commands, and documented routes?
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
- Does prose use plain words instead of runtime terms such as principal, settle, interaction, or fact, per the Plain words table in style-rules.md?
- Do sentences follow the ASD-STE100 rules in style-rules.md: one topic each, 25 words or fewer for descriptions, 20 or fewer for steps, and one meaning per term?
- Does each section lead with its key fact?
- Are headings descriptive enough to work as search results?
- Is critical information present locally rather than only behind links?
- Are sentences direct, active, and free of promotional or robotic phrasing?
- Did the edit preserve supported meaning, nuance, uncertainty, and strong existing prose?
- Are stock rhetorical patterns, filler, inflated claims, and mechanical rhythm removed where they add no value?
- Does each paragraph carry one fact the reader acts on or observes, without restating its neighbors or documenting internals?
- Are options and outcomes in tables or example comments rather than long paragraphs?

## Pass 5: Diff discipline

- Does every changed sentence fix an accuracy, usability, structure, or style problem?
- Did the edit preserve unrelated working content and anchors?
- Did it create contradictions elsewhere?
- Are all new files necessary?
- Did the edit leave the page shorter or the same length unless it added required behavior?

Leave clear, correct prose unchanged.
