---
status: draft
last_updated: "YYYY-MM-DD"
subject:
  repo: "<org>/<repo> @ <sha> (<branch>, <date>)" # <org> is the literal placeholder; never the name
  eve_pinned: "<version>"
  eve_compared_against: "<pin docs source>; CHANGELOG through <latest>"
scope: "read-only; every claim cites path:line; [V] read, [I] inferred from the code path, [R] unverified"
---

# <project>: eve gap register

<Three lines of facts: gap count, total lines in workaround-bearing files over
total project lines, internal imports or runtime reach-ins, disabled eve
defaults, issues the team has filed.>

|                   |                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Pin history       | <v> (<date>) → … → <v> (<date>)                                                                                                      |
| Surface           | <n> channels, <n> authored tools, <n> subagents, <n> hooks, <n> schedules, <n> connections, …; `instructions.md` <bytes>             |
| Filed against eve | <count and state of issues by the team's contributors, without numbers, e.g. "1, closed as withdrawn (<person-1>)"; or "none">; date |
| Code hygiene      | formatter/linter: <config or "none">; <n> lines >200 chars, <n> >400 in `<agent>/**/*.ts`; densest file `<path>` at <n> chars/line   |

## Index

| ID               | Gap          | Kind                              | Workaround (lines) | Tracked   |
| ---------------- | ------------ | --------------------------------- | ------------------ | --------- |
| [A1](#a1-<slug>) | <one clause> | own / buildable / docs / mismatch | ~n                 | #n / none |

## Upgrade exposure (<pin> → <latest>)

| Change                                    | Files that break | Changelog                  |
| ----------------------------------------- | ---------------- | -------------------------- |
| <removal or signature change> (<version>) | `path:line`, …   | `<sha>`, named / not named |

## Tool shape

<Facts only, from `sweep.sh` S12 and the files you opened. This section records
how the project distributed behavior between tools, approval policy, and
instructions. It is not a gap unless an eve limitation forced the shape; then
it also gets a gap block, cited. When a family member's description or a
comment states a reason for the narrow shape (least privilege, audit by tool
name, a non-technical audience), quote it here.>

|                                            |                                                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Authored tool files                        | <n> (<n> plain re-exports of `eve/tools/*`)                                                    |
| Tools with their own `approval:` config    | <n>                                                                                            |
| Tool names referenced in `instructions.md` | <n> of <n>; `instructions.md` <bytes>                                                          |
| What eve supports                          | <quote from `docs/tools/human-in-the-loop.md` on input-dependent approval policies, with line> |

| Family       | Members | Lines | With approval | Shared backend (`lib/` imports common to ≥2 members) |
| ------------ | ------- | ----- | ------------- | ---------------------------------------------------- |
| `<prefix>_*` | <n>     | <n>   | <n>           | `<lib>`, `<lib>`                                     |

<One excerpt: the input schema or execute body of two members of the largest
family, showing what differs between them.>

---

## A1. <gap, as a sentence about eve>

Kind: <own | buildable | docs | mismatch> · Area: <tasks | delivery | channels | auth | hitl | cost | budgets | subagents | sandbox | extensions | models | schedules | tooling | docs>

**Gap.** <Two to four sentences. What eve lacks or gets wrong, stated so a
reader with no knowledge of this project understands the hole. Name the eve
primitive, option, or event involved.>

**What eve says.** <Quoted fragments from eve docs, types, source, changelog,
or research notes with `path:line` and the version checked. If a newer eve
changes the picture, say which version and how. If an issue tracks it, number
and state. Tag.>

**What the project built.** <What, where (files with line ranges, approximate
lines), since which commit and date and pin. The project's own comments,
docs, and commit messages verbatim. Tag.>

**How it fails.** <Loud or silent, and the exact dependency that breaks it:
an event name, a token format, a response field, an adapter key, a changelog
entry. Inferred effects tagged [I]; untested behavior tagged [R].>

`path:start-end`

```ts
<verbatim excerpt showing the workaround or the project's stated reason>
```

`path:start-end`

```ts
<second excerpt if needed>
```

---
