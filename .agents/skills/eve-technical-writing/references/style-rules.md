# eve documentation style

## Names and capitalization

- Write `eve` lowercase.
- Match public API, CLI, provider, and product names exactly.
- Use sentence case for headings.
- Use American English and the Oxford comma.

## Voice

- Address the reader as `you` when the reader acts.
- Use imperative verbs for steps.
- Prefer active voice and present tense.
- Use neutral, instructional language.
- Avoid `easy`, `simple`, `quick`, `just`, `obviously`, `utilize`, `facilitate`, `leverage`, `robust`, and `seamless`.
- Avoid rhetorical questions, filler introductions, stacked fragments, and promotional claims.

## Formatting

- Use inline code for commands, flags, APIs, paths, filenames, and literal values.
- Use bold for interface labels or a critical fact, not routine emphasis.
- Add language identifiers to fenced code blocks.
- Use descriptive link text instead of `here` or bare URLs.
- Use Markdown in `.md`; use MDX-only syntax only in `.mdx`.
- Follow nearby docs for frontmatter and component conventions.

## Code and commands

- Prefer TypeScript unless the subject is language-agnostic.
- Include imports and enough context for examples to compile or run.
- Use placeholders such as `your_access_token_here` when readers must substitute values.
- Verify CLI syntax against current help or implementation.
- Do not invent expected output. Show it only when stable and useful.

## Lists and tables

- Use numbered lists for ordered procedures and bullets for related unordered information.
- Start procedure steps with one imperative action.
- Use tables when readers compare repeated fields or symptoms; keep column schemas consistent.
- Write complete sentences with periods when list items contain explanations.

## Troubleshooting

Use a symptom-first table when several failures share a workflow:

| Symptom            | Check                       | Next action             |
| ------------------ | --------------------------- | ----------------------- |
| Observable failure | Verified diagnostic surface | Supported recovery step |

Do not state a cause unless evidence supports it. When several causes produce the same symptom, tell the reader how to distinguish them.
