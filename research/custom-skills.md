---
issue: "None (maintainer-requested in PR #6106)"
status: proposed
last_updated: "2026-11-09"
---

# Custom skills

> **AI status:** Written entirely by AI; human review pending.

## Problem

Teams want the people who talk to an agent to teach it: a release checklist, a
writing voice, a channel's triage steps. Today that means editing the agent's
files and redeploying. Several internal projects built their own versions of
this, each with its own storage, scoping, and approval rules, and none of them
can share skills with the others.

## Proposal

A built-in extension, `eve/extensions/custom-skills`, that turns saved skills
into eve's existing dynamic skills and instructions. Mounting it is one file:

```ts
// agent/extensions/skills.ts
import customSkills from "eve/extensions/custom-skills";

export default customSkills({});
```

### Model

```text
scope (personal, channel, …)
 └─ skill  id (stable, never reused), name (unique in scope)
     ├─ version 1  immutable: description, instructions, mode, validation, author
     ├─ version 2  ← live
     └─ version 3  draft
```

- A clean first version goes live. Later saves are drafts. `publish` makes an
  exact version live in the mode it was saved with, `rollback` an earlier one,
  and `set_mode` changes how the live version applies.
- `always` skills join the system prompt, `on-demand` skills are listed for
  `eve__skill`, and `deferred` skills wait for `eve__search`.
- Load names are `<mount>__<name>` and `<mount>__<prefix>_<name>`; skill
  names never contain `_`, so scopes can't shadow each other or the agent.

### Extension points

| Option       | Default                                                                       | Replaces                                 |
| ------------ | ----------------------------------------------------------------------------- | ---------------------------------------- |
| `scopes`     | personal, plus `channel` from `ctx.conversation.space`                        | which owners' skills apply               |
| `approval`   | ask for publish, rollback, remove, and shared live changes; requester answers | who must approve what                    |
| `validate`   | routing descriptions and override warnings                                    | content rules (size limits always apply) |
| `limits`     | 100 skills, 5 always-on and 20,000 characters per scope                       | prompt and storage bounds                |
| `repository` | a versioned layout in any `eve/memory/file` store                             | storage                                  |
| `onChange`   | none                                                                          | audit and mirroring                      |

`eve/extensions/custom-skills/policies` exports the defaults to compose with,
and `/repository` exports the storage contract and the default store.

## Invariants

- **An approval applies to what its card showed.** Changing tools take the
  skill's ID, versions are immutable, and each tool writes against the scope
  revision its approval rule judged. A skill recreated under the same name, or
  a scope that changed mid-flight, fails the call instead of applying content
  nobody approved.
- **Limits hold under concurrency.** Writes pass the scope revision they were
  checked at, so concurrent writers in a shared scope can't exceed the limits.
- **Personal scopes are keyed by eve's full principal identity**: authenticator,
  issuer, principal type, principal ID, and subject.
- **Storage is a contract.** The default layout is versioned (`v1`), readable,
  and indexed so a whole store can be listed without key listing.

## Boundaries

- Skills are text the model reads. They aren't authorization: approval rules,
  scopes, and validation are enforced in code.
- Deleting a skill tombstones its documents; a store with object history keeps
  the old content.
- Always-on limits are per scope, so several scopes in one turn add up.

## Open questions

- A per-turn cap on always-on characters across scopes.
- Whether the routing-description rule should be part of the default at all, or
  only a recommendation in the `manage` skill.
