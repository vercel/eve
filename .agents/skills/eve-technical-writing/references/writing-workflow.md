# Writing new eve documentation

## 1. Research the task

Identify:

- What the reader needs to accomplish or understand
- Where the task begins and ends
- Current source, tests, CLI help, or platform documentation that verifies it
- Existing eve pages that overlap
- Common failures from support evidence
- Product work that is not yet shipped

Do not draft until the supported workflow and its boundaries are clear.

## 2. Choose one content type and job

Use [content-types.md](content-types.md) as a structural heuristic. Do not add `contentType` frontmatter solely because this skill categorizes the page.

Prefer extending an existing owner page. Create a page only when the topic has a distinct user goal, enough stable content, and no clear existing home.

## 3. Outline before drafting

Write the headings first. Order them around the reader's workflow:

1. Outcome or definition
2. Prerequisites or boundaries
3. Supported happy path
4. Alternatives
5. Failure modes or limitations
6. Related tasks

For a small page, omit sections that add no value.

## 4. Draft and verify together

- Verify every command, flag, identifier, and example before adding it.
- Prefer complete TypeScript examples with current imports.
- Explain what a command changes and what success looks like when that is stable and observable.
- Use exact terms that match code and CLI output.
- Separate current behavior from proposed product work.

## 5. Self-edit

Remove repetition, filler, unsupported qualifiers, and implementation detail the reader cannot act on. Confirm that each section makes sense when retrieved independently.
