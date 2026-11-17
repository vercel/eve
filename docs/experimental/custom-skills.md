---
title: "Custom Skills Extension"
description: "Let the people who talk to your agent save their own versioned skills, for themselves or for everyone in a channel."
---

`eve/experimental/extensions/custom-skills` lets the people who talk to an agent teach it their own [skills](/docs/skills): a release checklist, a writing style, a team's triage steps. A person asks the agent to save one, and it applies from their next message.

- **Personal and shared.** Personal skills follow their owner into every conversation. Shared skills apply to everyone in a channel or group chat.
- **Versions.** Each save is an immutable version. A skill's first clean version goes live; later saves are drafts until someone publishes them, and publishing an earlier version rolls back to it.
- **Application modes.** An `always` skill is in the system prompt on every turn, such as a persona. An `on-demand` skill is listed for the model to load when it's relevant. A `deferred` skill stays out of the prompt until the model searches for it.
- **Approval.** Publishing, rolling back, deleting, and anything that goes live in a shared scope wait for approval. The approval card shows the content that would apply.

This extension ships in the `eve` package and is experimental.

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

| Name               | What it does                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `skills__create`   | Saves a new version of a skill.                                                                                   |
| `skills__list`     | Lists a scope's skills, with their IDs, versions, drafts, and modes.                                              |
| `skills__publish`  | Makes an exact version live: a newer draft, or an earlier version to roll back. Asks for approval.                |
| `skills__read`     | Reads one version, with a list of every version. Deferred.                                                        |
| `skills__set_mode` | Changes how the live version applies. Deferred.                                                                   |
| `skills__remove`   | Deletes skills with every version. Asks for approval. Deferred.                                                   |
| `skills__manage`   | A skill explaining how to create, publish, and manage custom skills, which the model loads before making changes. |

Deferred tools stay out of the tool list until the model finds them with [`eve__search`](/docs/concepts/built-in-tools#eve__search-eve__tool-and-eve__skill), so the extension adds three tools to every request.

Custom skills load as `skills__<name>`, or `skills__channel_<name>` for shared skills, so they don't shadow the agent's skills or each other. Keep the mount name to 14 characters or fewer so loadable skill names stay within the 64-character limit with the default 40-character `maxNameLength`.

`publish`, `set_mode`, and `remove` require both the skill's `id` and `name`, which `list` and `create` return. Binding approvals to the `id` ensures that if a skill is deleted and recreated under the same name before approval finishes, the approved call is rejected.

## Scopes

By default, every signed-in user gets a `personal` scope. Anonymous callers and runtime callers, such as schedules running as the app, don't get a scope, so one run cannot save skills that affect later runs. In a shared conversation [space](/docs/channels#spaces) such as a Slack, Discord, or Teams channel or group chat, the caller also gets a `channel` scope shared with everyone in that space. Direct messages do not have a shared scope.

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

A scope's `key` sets its storage path and must be unique per user or shared group. `label` describes the scope's audience to the model and in approval cards. `shared` marks a multi-user scope so the default approval policy requires stricter approval. `readOnly` allows listing and loading skills while rejecting modifications, and `loadPrefix` prefixes the scope's loaded skill names so scopes don't collide.

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

`defaultSkillApproval` requires approval before publishing, rolling back, or removing a skill, and before any change goes live in a shared scope. Saving a draft, creating the first version of a personal skill, and changing a personal skill's mode do not require approval. Shared changes are rejected if the approval card (up to 3,000 characters, including the description) cannot display the full content.

`approval.response` is an [approval response policy](/docs/human-in-the-loop#authorizing-approval-responses) that controls who can approve a change. By default, only the requester can approve a personal change, and a different user must approve a shared change. Before executing, the tool also verifies that the approver is authorized for the target scope. For admin-only shared skills, check `response.principal` in your own policy.

When a tool runs, it rechecks the skill state that was evaluated for approval. If the skill changed while waiting, the tool call fails so the model can retry; if creating a first version now requires approval, it is saved as a draft instead.

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

Deleting a skill overwrites its versions with empty documents because `MemoryDocumentBackend` does not have a delete operation. If your storage backend retains version history, older object versions still contain the previous content.

To keep skills in your own database, implement `SkillRepository` from `eve/experimental/extensions/custom-skills/repository` and pass it as `repository`. Its documentation covers the contract: never reuse an ID, number versions without gaps, and reject a stale `expectedRevision` with `SkillConflictError` so concurrent changes can't exceed the limits.
