---
name: manage
description: Lifecycle rules for user-created custom skills — versions and drafts, application modes, publishing, rollback, deletion, and scopes. Load before creating, listing, reading, publishing, rolling back, changing the mode of, or deleting a custom skill.
---

# Managing custom skills

These rules apply to custom skills saved with this extension's `create` tool.
The agent's own authored skills have no lifecycle versions.

- A clean first version goes live immediately. Every later save is an
  immutable draft; the live version changes only when `publish` succeeds.
- Version state and application mode are separate. The live (`active`)
  version is what applies. Versions above it are drafts; versions below it
  are superseded and can be restored with `rollback`.
- Every `create` call needs `applicationMode`:
  - `always` for a persona, writing preference, or standing behavior. It is
    injected on every turn.
  - `on-demand` for a task procedure. It is listed in the prompt and loads
    when relevant.
  - `deferred` for a rarely needed procedure. It stays out of the prompt
    until a skill search finds it.
- An `on-demand` or `deferred` description is a routing condition and must
  start with "Use when the user asks", "requests", "wants", or "needs". If
  `create` or `set_mode` rejects it, save a new version with a routing
  description.
- On-demand and deferred skills load through the skill loader under their
  advertised name, which carries the mount prefix and, for shared scopes such
  as `channel`, a scope prefix. `list` and `create` return that `loadName`.
  Lifecycle tools take the bare name plus `scope`.
- Changes apply from the next message, not the current turn.
- Use `versions` and `read` to inspect an exact draft before publishing it.
- `publish`, `rollback`, and `remove` are approval-gated. Call them directly
  with the exact target: the approval card is the only confirmation, so never
  ask first in prose or with a question tool.
- `set_mode` is reversible; the user's explicit request authorizes it.
- When a live skill is not applying, check its application mode before
  anything else. Never publish a version that is already live; switch an
  `on-demand` skill with persistent behavior to `always` with `set_mode`.
- To delete several skills, call `list` once, then `remove` once with every
  name.
- Default to the personal scope. Use a shared scope such as `channel` only
  when the user asks for a team or channel skill. A shared-scope change
  affects everyone in that scope.
- After an approval or denial, report the actual tool result. Never call a
  draft live before `publish` succeeds.
