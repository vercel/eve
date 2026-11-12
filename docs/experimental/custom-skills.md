---
title: "Custom Skills Extension"
description: "Let the people who talk to your agent save their own versioned skills, for themselves or for everyone in a channel."
---

`eve/experimental/extensions/custom-skills` lets the people who talk to an agent teach it their own [skills](/docs/skills): a release checklist, a writing style, a team's triage steps. A person asks the agent to save one, and it applies from their next message.

- **Personal and shared.** Personal skills follow their owner into every conversation. Shared skills apply to everyone in a channel or group chat.
- **Versions.** Each save is an immutable version. A skill's first clean version goes live; later saves are drafts until someone publishes them, and publishing an earlier version rolls back to it.
- **Application modes.** An `always` skill is in the system prompt on every turn, such as a persona. An `on-demand` skill is listed for the model to load when it's relevant. A `deferred` skill stays out of the prompt until the model searches for it.
- **Approval.** Publishing, rolling back, deleting, and anything that goes live in a shared scope wait for approval. The approval card shows the content that would apply.

It ships inside the `eve` package. This extension is experimental and may change: import it from `eve/experimental/extensions/custom-skills`.

## Mount it

```ts title="agent/extensions/skills.ts"
import customSkills from "eve/experimental/extensions/custom-skills";

export default customSkills({});
```

The extension stores skills in [Vercel Blob](/docs/memory/file) when `BLOB_READ_WRITE_TOKEN`, or `BLOB_STORE_ID` with Vercel OIDC, is set. Without storage, no custom skills load and the tools say storage is missing. For local development, pass a store:

```ts title="agent/extensions/skills.ts"
import customSkills from "eve/experimental/extensions/custom-skills";
import { inMemory } from "eve/memory/file";

export default customSkills({ storage: inMemory() });
```

Give each agent that shares a Blob store its own `namespace`, or the agents share every user's skills.

## What the agent gets

The mount name prefixes everything. Mounted as `skills`, the agent gets:

| Name               | What it does                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `skills__create`   | Saves a new version of a skill.                                                                    |
| `skills__list`     | Lists a scope's skills, with their IDs, versions, drafts, and modes.                               |
| `skills__publish`  | Makes an exact version live: a newer draft, or an earlier version to roll back. Asks for approval. |
| `skills__read`     | Reads one version, with a list of every version. Deferred.                                         |
| `skills__set_mode` | Changes how the live version applies. Deferred.                                                    |
| `skills__remove`   | Deletes skills with every version. Asks for approval. Deferred.                                    |
| `skills__manage`   | A skill with the lifecycle rules, which the model loads before changing skills.                    |

Deferred tools stay out of the tool list until the model finds them with [`eve__search`](/docs/concepts/built-in-tools#eve__search-eve__tool-and-eve__skill), so the extension adds three tools to every request.

People's skills load as `skills__<name>`, or `skills__channel_<name>` for shared ones, so they can't shadow the agent's own skills or each other. Keep the mount name short: a loadable skill name is at most 64 characters, so with the default 40-character skill names, the mount name has 14.

`publish`, `set_mode`, and `remove` take a skill's `id` as well as its name, which the model reads from `list` or `create`. An approval then applies only to the skill its card showed: if someone deletes the skill and saves a new one under the same name while the approval waits, the approved call is refused.

## Scopes

By default, every signed-in person has a `personal` scope. Anonymous callers and runtime principals, such as a schedule that runs as the app, have none, so one run can't leave skills for every later run. When the conversation happens in a shared place, such as a Slack, Discord, or Teams channel or a group chat, the caller also has a `channel` scope that everyone there shares. It comes from the conversation's [space](/docs/channels#spaces), so direct messages have no shared scope.

Pass `scopes` to change which scopes apply. Compose with the built-in ones from `eve/experimental/extensions/custom-skills/policies`, for example to add read-only company skills:

```ts title="agent/extensions/skills.ts"
import customSkills from "eve/experimental/extensions/custom-skills";
import { defaultScopes } from "eve/experimental/extensions/custom-skills/policies";

export default customSkills({
  scopes: async (ctx) => {
    const scopes = [...(await defaultScopes(ctx))];
    const tenant = ctx.session.auth.current?.attributes.tenant_id;
    if (typeof tenant === "string") {
      scopes.push({
        name: "company",
        key: `tenant:${tenant}`,
        label: "everyone at the company",
        shared: true,
        readOnly: true,
        loadPrefix: "company",
      });
    }
    return scopes;
  },
});
```

A scope's `key` says where its skills are stored and must be unique per owner. `label` is how the model and approval cards name who the skills are for. `shared` marks a scope many people use, which the default approval rule treats more carefully. `readOnly` lists and loads skills but refuses changes, and `loadPrefix` keeps the scope's load names apart from other scopes'.

## Approval

`approval.request` decides, for each change, whether it runs, asks a person, or is refused. It receives the action, the scope, the caller, whether the change alters what applies, and the content and live state of each skill it affects:

```ts title="agent/extensions/skills.ts"
import customSkills from "eve/experimental/extensions/custom-skills";
import { defaultSkillApproval } from "eve/experimental/extensions/custom-skills/policies";

export default customSkills({
  approval: {
    // Shared skills are managed by admins; everything else follows the default.
    request: (change) =>
      change.scope.shared && !isAdmin(change.caller)
        ? { deny: "Only admins can change this channel's skills." }
        : defaultSkillApproval(change),
  },
});
```

`defaultSkillApproval` asks before publishing, rolling back, or removing, and before anything goes live in a shared scope. A personal first version and a personal mode change run without asking, and a draft never asks. A shared change is refused when its approval card, at most 3,000 characters including the skill's description, can't show it in full, so whoever approves reads everything.

`approval.response` is an eve [approval response policy](/docs/human-in-the-loop#authorizing-approval-responses) that decides who may answer. By default, only the person who asked can approve a personal change, and a shared change needs someone else, so no one person can put text into everyone's prompt alone. Approvals are judged without the conversation, so the tool checks the approver again against the scope the change really targets before it runs. For admin-only shared skills, check `response.principal` in your own policy.

The tools check their change again when they run, against the state their approval rule judged. If the skills changed in the meantime, the change fails and the model tries again; a first version that now needs approval nobody gave is saved as a draft instead.

## Validation

`validate` replaces the built-in content rules. By default, an on-demand or deferred skill's description must say when to load it ("Use when the user asks…"), and instructions that try to override higher-priority rules or bypass approval raise warnings, which keep a first version in draft. Required fields, `limits`, and control characters are always checked.

```ts title="agent/extensions/skills.ts"
import customSkills from "eve/experimental/extensions/custom-skills";
import { defaultSkillValidator } from "eve/experimental/extensions/custom-skills/policies";

export default customSkills({
  validate: (input) =>
    input.description.startsWith("Úsalo cuando")
      ? { errors: [], warnings: [] }
      : defaultSkillValidator(input),
});
```

The validator runs on save, publish, rollback, and mode changes, so a version saved under older rules is checked against the current ones before it applies.

## Limits

| Limit                   | Default          |
| ----------------------- | ---------------- |
| `maxSkills`             | 100 per scope    |
| `maxAlwaysOn`           | 5 per scope      |
| `maxAlwaysOnCharacters` | 20,000 per scope |
| `maxNameLength`         | 40               |
| `maxDescriptionLength`  | 280              |
| `maxInstructionsLength` | 20,000           |

Always-on limits apply per scope, so a turn with a personal and a channel scope can add up to twice `maxAlwaysOnCharacters` to the prompt.

## Audit changes

`onChange` runs after each change with the skill, what was live before, who asked, and who approved, for an audit log or an inventory elsewhere:

```ts title="agent/extensions/skills.ts"
import customSkills from "eve/experimental/extensions/custom-skills";

export default customSkills({
  onChange: async (event) => {
    await auditLog.write({
      kind: event.kind,
      scope: event.scope.name,
      actor: event.actor?.principalId,
      approvedBy: event.approvedBy?.principalId,
      skills: event.kind === "removed" ? event.skills : [event.skill],
    });
  },
});
```

A failing `onChange` is logged and doesn't undo the change.

## Storage

Every skill has a stable `id`, the same across its versions and never reused, and a `name` that is unique within its scope. Use the ID to link a skill to records elsewhere.

The default store keeps a versioned layout under `namespace`, which other tools can read:

```text
<namespace>/v1/index.json                                  every scope that has held skills
<namespace>/v1/scopes/<scope key>/catalog.json             the scope's skills by ID
<namespace>/v1/scopes/<scope key>/skills/<id>/<uuid>.json  one immutable version
```

The index makes the store listable for an admin view or library:

```ts
import { documentRepository } from "eve/experimental/extensions/custom-skills/repository";
import { vercelBlob } from "eve/memory/file/vercel";

const skills = documentRepository({ backend: vercelBlob(), namespace: "support-agent" });
for (const scope of (await skills.listScopes?.()) ?? []) {
  const { heads } = await skills.listHeads(scope);
  console.log(
    scope.label,
    heads.map(({ id, name, liveVersion }) => ({ id, name, liveVersion })),
  );
}
```

If a scope's storage can't be read, such as during a Blob outage, its skills are skipped for that turn and the model is told they're unavailable; other scopes and the rest of the turn are unaffected. A catalog entry or version that doesn't parse is skipped and left in place for repair.

Deleting a skill overwrites its versions with empty documents, because memory document stores have no delete. A store that keeps object history still holds the old content.

To keep skills in your own database, implement `SkillRepository` from `eve/experimental/extensions/custom-skills/repository` and pass it as `repository`. Its documentation covers the contract: never reuse an ID, number versions without gaps, and reject a stale `expectedRevision` with `SkillConflictError` so concurrent changes can't exceed the limits.
