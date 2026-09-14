---
issue: https://github.com/vercel/eve/issues/2017
status: implemented
last_updated: "2026-08-12"
---

# Role-aware instructions

Instructions need to represent both framework authority and durable application
context. Treating every definition as a system prompt forces retrieved memory,
tenant briefs, and similar user-owned data into the highest-authority position
and keeps it outside normal history controls.

## Authoring API

```ts
defineInstructions({ content: "Standing policy" });
defineInstructions({ content: "Retrieved customer brief", role: "user" });
```

`role` is `"system" | "user"` and defaults to `"system"`. The deprecated
`{ markdown: string }` shape remains a system-role compatibility form. Shapes
are exact: definitions cannot mix `markdown` and `content`, put a role beside
`markdown`, or supply unknown fields. `instructions.md` remains system-role.

The `eve/instructions` `defineDynamic` surface accepts only `session.started`
and `turn.started`; handlers return `defineInstructions(...)` or `null`.

## Runtime semantics

| Source            | System role                                 | User role                                         |
| ----------------- | ------------------------------------------- | ------------------------------------------------- |
| Static            | Current compiled prompt on every model call | Seeded once when fresh session history is created |
| `session.started` | Session-scoped prompt context               | Appended once before turn-scoped context          |
| `turn.started`    | Turn-scoped prompt context                  | Appended once before the current delivery         |

Blank content materializes nothing. Static and dynamic user entries become
ordinary durable messages, so compaction may summarize them and clear removes
them without rerunning a definition. System entries remain outside history.

Instruction resolver snapshots follow the same boundary: session resolvers see
static user entries, and turn resolvers additionally see session-start user
entries. Other dynamic resolver snapshots do not change.

User results are staged in an instructions-only virtual queue until the
lifecycle preamble completes, then committed with session-before-turn ordering.
That keeps retries, workflow replay, parking, and resume from duplicating a
message. There is intentionally no content deduplication across distinct
lifecycle events.

## Boundaries

- No `step.started` instruction resolver. Step-volatile context belongs in a
  tool, model input, or another existing surface.
- No backwards fallback for mixed definitions or unsupported roles.
- Inspection reports ordered static definitions and their roles; dynamic values
  remain runtime-only.
- Static user entries are pinned to the session that received them. A new
  deployment refreshes system-role instructions but does not rewrite history.
