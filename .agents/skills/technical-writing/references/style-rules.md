# eve documentation style

## Names and capitalization

- Write `eve` lowercase.
- Match public API, CLI, provider, and product names exactly.
- Use sentence case for headings.
- Use American English and the Oxford comma.

## Voice

- Be clear and concise. Follow these ASD-STE100 rules where they apply:
  - Use one word for one meaning, and keep a term once you choose it.
  - Keep one topic in each sentence.
  - Keep descriptive sentences to 25 words or fewer and procedural steps to 20 or fewer.
  - Keep necessary technical terms, product names, and code identifiers exactly as written.
- Address the reader as `you` when the reader acts.
- Use imperative verbs for steps.
- Prefer active voice and present tense.
- Use neutral, instructional language.
- Avoid `easy`, `simple`, `quick`, `just`, `obviously`, `utilize`, `facilitate`, `leverage`, `robust`, and `seamless`.
- Avoid rhetorical questions, filler introductions, stacked fragments, and promotional claims.

## Plain words

Write prose in the words a reader uses for what they see, not in eve's runtime model. Use a runtime term only where the reader must type it or will read it in output. Format it as code, and explain it in plain words the first time it appears on the page.

| Runtime term           | In prose, write                                                                  |
| ---------------------- | -------------------------------------------------------------------------------- |
| principal              | the user, the caller, or the person who clicked; name which one                  |
| settle, settled        | finish, end, or complete; keep `*.settled` only as an event name                 |
| interaction            | the approval, question, or sign-in; "request for input" when it covers all kinds |
| fact                   | event                                                                            |
| scope (of an event)    | the turn, call, or task the event belongs to                                     |
| capability             | the tool, connection, or skill                                                   |
| delivery               | the message, when it is one                                                      |
| owner, ownership       | the deployment that runs the session                                             |
| commit, committed      | recorded or saved                                                                |
| durable                | say what survives, once: "survives restarts and redeploys"                       |
| lifecycle              | what happens from start to finish                                                |
| lower into, project as | expose as, show as                                                               |

Keep exact API names, field names, event names, and error codes in code formatting. The table covers the prose around them.

## Current behavior only

- Describe what eve does today. Do not narrate how it changed.
- Avoid change words that describe eve's own history: `no longer`, `now`, `previously`, `earlier versions`, `legacy`, `has been removed`, `renamed`, and `deprecated`. Runtime states are fine, as in "the session is no longer active."
- Do not mention removed options, old file paths, old event names, or old package names.
- Put upgrade steps in changesets and release notes, not in docs pages.
- When an old configuration still produces an error, add a troubleshooting row keyed on the exact error text and state the fix in present tense.

## Density

- Open a page with what the thing is and where it lives: "A subagent is a child agent the model can delegate to. Each one lives under `agent/subagents/<name>/`."
- Skip preambles such as "This page covers" or "In this guide, you'll learn". The first sentence is content.
- Keep one fact per paragraph, in one to three sentences.
- State defaults as what to omit: "Omit `model` to inherit the parent's model."
- Name exact values instead of describing them: event names, status codes, field values, and error strings.
- Fold a reason into the sentence with `because` or `so`, and keep it only when the reader needs it to act.
- When several items share one rule, list them inline in one sentence instead of one bullet each.
- Document behavior the reader acts on or observes. Leave out implementation details; see [Contract, not mechanism](#contract-not-mechanism).
- State a limitation once, on the page that owns it, and link to it from elsewhere.
- Cut sentences that restate the previous one or list what a feature does not do, unless they prevent a likely mistake.
- Close a feature page with a short section that says when to use the neighboring feature instead, and link to it.

## Contract, not mechanism

Document eve's contract: public APIs, configuration, observable behavior, guarantees, limits, and errors. Leave out the mechanism that implements it.

- Do not name internal modules, functions, classes, files under `packages/eve/src`, internal routes, or storage layouts.
- Do not describe internal algorithms, step sequencing, caching, retries, encodings, or data structures.
- When a guarantee depends on a mechanism, state the guarantee: "a retry with the same `idempotencyKey` is accepted once", not how eve stores recent keys.
- Keep a mechanism only when the reader must know it to configure, debug, or reason about a limit, and then describe only the part they act on. Example: a retention window that decides when a stream returns `410`.
- Name only exported APIs, documented CLI commands, and documented routes. If a reader needs an unexported internal, that is a product gap. Report it; do not document it.

## Formatting

- Use inline code for commands, flags, APIs, paths, filenames, and literal values.
- Use bold for interface labels or a critical fact, not routine emphasis.
- Add language identifiers to fenced code blocks.
- Use descriptive link text instead of `here` or bare URLs.
- Use Markdown in `.md`; use MDX-only syntax only in `.mdx`.
- Follow nearby docs for frontmatter and component conventions.

## Code and commands

- Show one canonical example per concept. Add variants only for different tasks.
- Annotate small surfaces with comments inside the example, such as `// omit to inherit the parent's model`, instead of a separate paragraph or table.
- Show a file tree next to the code for anything that lives on disk.
- Show the real error payload when readers will hit it, followed by the fix.
- Prefer TypeScript unless the subject is language-agnostic.
- Include imports and enough context for examples to compile or run.
- Use placeholders such as `your_access_token_here` when readers must substitute values.
- Verify CLI syntax against current help or implementation.
- Do not invent expected output. Show it only when stable and useful.

## Lists and tables

- Use numbered lists for ordered procedures and bullets for related unordered information.
- Start procedure steps with one imperative action.
- Use tables for lookup: options, fields, identifiers, outcomes, and symptoms. Keep column schemas consistent.
- Keep table cells short. A cell that needs several sentences belongs in a paragraph.
- Write complete sentences with periods when list items contain explanations.

## Troubleshooting

Use a symptom-first table when several failures share a workflow:

| What you see                | What to do                                                 |
| --------------------------- | ---------------------------------------------------------- |
| Observable failure or error | Imperative fix, with the cause folded in through `because` |

Open a troubleshooting page with the few checks that catch most problems. Do not state a cause unless evidence supports it. When several causes produce the same symptom, tell the reader how to distinguish them.
