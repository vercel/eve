---
name: manage
description: Lifecycle rules for user-created custom skills — versions and drafts, application modes, publishing, rollback, deletion, scopes, and approvals. Load before creating, listing, reading, publishing, rolling back, changing the mode of, or deleting a custom skill.
---

# Managing custom skills

These rules apply to custom skills saved with this extension's `create` tool.
The agent's own authored skills have no lifecycle versions.

`create`, `list`, and `publish` are always available. `read`, `set_mode`,
and `remove` are deferred: find them with `eve__search` (for example "read
custom skill") and call them through `eve__tool`.

- A clean first version goes live immediately. Every later save is an
  immutable draft: it changes neither the live version nor how it applies.
  The live version changes only when `publish` succeeds.
- Each version is saved with an application mode, and it applies in that
  mode once published. `set_mode` changes how the live version applies.
- The live (`active`) version is what applies. Versions above it are drafts;
  versions below it are superseded. To roll back, `publish` the earlier
  version.
- Every `create` call needs `applicationMode`:
  - `always` for a persona, writing preference, or standing behavior. It is
    injected on every turn.
  - `on-demand` for a task procedure. It is listed in the prompt and loads
    when relevant.
  - `deferred` for a rarely needed procedure. It stays out of the prompt
    until a skill search finds it.
- An `on-demand` or `deferred` description is a routing condition that says
  when to load the skill, such as "Use when the user asks for a deploy
  checklist." If `create`, `publish`, or `set_mode` rejects a description or
  instructions, save a new version that follows the error.
- On-demand and deferred skills load through the skill loader under their
  advertised name, which carries the mount prefix and, for shared scopes such
  as `channel`, a scope prefix. `list` and `create` return that `loadName`.
  Lifecycle tools take the bare name plus `scope`.
- Changes apply from the next message, not the current turn.
- Use `read` to inspect an exact draft before publishing it; it also lists
  every version.
- `publish`, `set_mode`, and `remove` take each skill's `id` as
  well as its name, from `list`, `read`, or `create`. If a call says the skill
  was replaced, or that the scope changed while it was checked, list the
  skills again and call it with the current id.
- Some changes need approval, such as publishing, rolling back, deleting, and
  anything that goes live in a shared scope. Call the tool directly with the
  exact target: the approval card shows the change and is the only
  confirmation, so never ask first in prose or with a question tool.
- When a live skill is not applying, check its application mode before
  anything else. Never publish a version that is already live; switch an
  `on-demand` skill with persistent behavior to `always` with `set_mode`.
- To delete several skills, call `list` once, then `remove` once with every
  skill's name and id.
- `list` names the scopes available here. Default to the personal scope. Use a
  shared scope such as `channel` only when the user asks for a team or channel
  skill. A shared-scope change affects everyone in that scope. A read-only
  scope's skills can be loaded but not changed.
- After an approval or denial, report the actual tool result. Never call a
  draft live before `publish` succeeds.
