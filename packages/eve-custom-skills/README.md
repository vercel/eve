# eve/extensions/custom-skills

`eve/extensions/custom-skills` lets the people talking to an agent save their own skills: personal skills that follow a user everywhere, and shared skills for everyone in a channel or group chat.

It ships inside the `eve` package. This private `@eve/custom-skills` workspace package is its source of truth: eve's build copies `extension/` into `packages/eve/src/extensions/custom-skills/extension` and publishes it as `eve/extensions/custom-skills`, with helpers at `eve/extensions/custom-skills/policies` and `eve/extensions/custom-skills/repository`.

- **Immutable versions, one live version.** A clean first version goes live. Later saves are drafts that change nothing until `publish`, and `rollback` makes an exact earlier version live again. A version's status follows from the live version: `active`, `superseded` below it, `draft` above it.
- **Three application modes, saved per version.** `always` injects the skill into the system prompt every turn. `on-demand` lists it for `eve__skill`. `deferred` keeps it out of the prompt until `eve__search` finds it. A version applies in the mode it was saved with; `set_mode` changes the live version's.
- **Validation you can replace.** By default, on-demand and deferred descriptions must be routing conditions ("Use when the user asks…"), and instructions that try to override or bypass higher-priority rules raise warnings, which hold a first version in draft. Size and control-character limits always apply.
- **Approval you configure.** An approval rule decides, for each change, whether it runs, asks a person, or is refused. The approval card shows the content that would go live.

## Mount

```ts
// agent/extensions/skills.ts
import customSkills from "eve/extensions/custom-skills";

export default customSkills({});
```

With `BLOB_READ_WRITE_TOKEN` (or `BLOB_STORE_ID` plus Vercel OIDC) set, that is all. Without storage, no custom skills load and the tools say storage is missing. For local development, pass `storage: inMemory()` from `eve/memory/file`.

The mount name prefixes everything. Mounted as `skills`, the agent gets `skills__create`, `skills__list`, `skills__read`, `skills__versions`, `skills__publish`, `skills__rollback`, `skills__set_mode`, `skills__remove`, the `skills__manage` lifecycle skill, and user skills that load as `skills__<name>` (personal) or `skills__channel_<name>` (shared). The prefix means a user's skill can never shadow one of the agent's own skills, and because skill names never contain `_`, a shared skill can never collide with a personal one. The name `manage` is reserved for the lifecycle skill. Keep `<mount>__<prefix>_<name>` within eve's 64-character skill name limit: with the default 40-character `maxNameLength`, keep the mount name to 14 characters or fewer.

## Configure

| Option       | Default                                   | Purpose                                                                                                        |
| ------------ | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `storage`    | Vercel Blob when configured               | Any `MemoryDocumentBackend` from `eve/memory/file`, such as `vercelBlob()` or `inMemory()`.                    |
| `namespace`  | `custom-skills`                           | Key prefix in `storage`. Give each agent that shares a store its own, or they share every user's skills.       |
| `repository` | none                                      | Your own `SkillRepository`, such as database tables. Replaces `storage`.                                       |
| `scopes`     | `defaultScopes`                           | Returns the turn's `SkillScope`s in precedence order. The first is the default scope for the tools.            |
| `approval`   | `defaultSkillApproval`, requester answers | `request` decides whether a change runs, asks, or is refused; `response` decides who may answer.               |
| `validate`   | `defaultSkillValidator`                   | Checks descriptions and instructions on save, publish, and mode changes; errors reject, warnings hold a draft. |
| `limits`     | See below                                 | Skill count, always-on count and size, and name, description, and instruction lengths.                         |
| `onChange`   | none                                      | Runs after each change with the skill, what was live before, who asked, and who approved. Failures are logged. |

### Scopes

`defaultScopes` gives every signed-in caller a `personal` scope, and adds a shared `channel` scope when the conversation happens in a shared place: eve's `ctx.conversation.space` for Slack, Discord, Teams, Telegram, and Chat SDK channels. Direct messages have no shared scope.

A `SkillScope` names its `key` (where its skills are stored), `label` (who they're for), whether it is `shared`, an optional `loadPrefix`, `readOnly`, and `metadata` for your repository. Compose your own from `personalScope` and `spaceScope` in `eve/extensions/custom-skills/policies`:

```ts
import customSkills from "eve/extensions/custom-skills";
import { defaultScopes } from "eve/extensions/custom-skills/policies";

export default customSkills({
  scopes: async (ctx) => {
    const tenant = ctx.session.auth.current?.attributes.tenant_id;
    const scopes = [...(await defaultScopes(ctx))];
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

### Approval

`approval.request` receives the action (`create`, `publish`, `rollback`, `set_mode`, or `remove`), the scope, the caller, whether the change alters what applies (`changesLive`), and each target's content and live state. It returns `"allow"`, `"ask"`, or `{ deny: reason }`. The default, `defaultSkillApproval`, asks before publishing, rolling back, or removing, and before anything goes live in a shared scope; drafts never ask.

The tool plans the change again when it runs. A change that now needs approval nobody gave is refused, and a first version waits as a draft instead of going live.

`approval.response` is an eve `ApprovalResponsePolicy`. By default only the person who asked can answer; allow channel admins, for example, by checking `response.principal`.

### Validation

`validate` replaces the built-in content rules. It receives the `action` (`save`, `publish`, or `set_mode`), the scope, the name, description, instructions, and the mode the version would apply in, and returns `{ errors, warnings }`. Errors reject the change with a message the model sees; warnings on save hold a first version in draft and show on the approval card. Required fields, `limits`, and control characters are checked first and can't be replaced.

Compose with `defaultSkillValidator` from `eve/extensions/custom-skills/policies`, for example to accept descriptions in another language or skip the routing rule for skills imported from another system:

```ts
import customSkills from "eve/extensions/custom-skills";
import { defaultSkillValidator } from "eve/extensions/custom-skills/policies";

export default customSkills({
  validate: async (input) => {
    if (input.description.startsWith("Úsalo cuando")) return { errors: [], warnings: [] };
    return defaultSkillValidator(input);
  },
});
```

The validator also runs when a version is published or rolled back to, and when the live version's mode changes, so a version saved under older rules is checked against the current ones before it applies.

### Limits

| Limit                   | Default          |
| ----------------------- | ---------------- |
| `maxSkills`             | 100 per scope    |
| `maxAlwaysOn`           | 5 per scope      |
| `maxAlwaysOnCharacters` | 20,000 per scope |
| `maxNameLength`         | 40               |
| `maxDescriptionLength`  | 280              |
| `maxInstructionsLength` | 20,000           |

Always-on limits apply per scope, so a turn with a personal and a channel scope can inject up to twice `maxAlwaysOnCharacters`.

## Storage

Every skill has a stable `id`, the same across its versions and in every `onChange` event, and a `name` that is unique within its scope. People and the model use names; use the ID to link a skill to records elsewhere. The tools remove skills by the ID they planned with, so a skill recreated under the same name isn't removed by an earlier approval.

The default store writes a documented, versioned layout under `namespace`:

```text
<namespace>/v1/index.json                                  every scope that has held skills, with its descriptor
<namespace>/v1/scopes/<scope key>/catalog.json             the scope's skills by ID: name, live version, mode, version index
<namespace>/v1/scopes/<scope key>/skills/<id>/<uuid>.json  one immutable version
```

Scope keys and IDs are path segments encoded with `encodePathSegment`: letters, digits, `-`, and `_` stay, and every other byte becomes `~` and two hex digits, so `space:slack:T1:C1` is stored as `space~3aslack~3aT1~3aC1`. The `v1` segment is the layout version; a later layout gets its own prefix and a migration, instead of reinterpreting these documents.

Memory document backends can't list keys, so the index is what makes the store scannable. `listScopes()` returns every scope that has held skills, which an admin view or library can combine with `listHeads` and `getVersions`:

```ts
import { vercelBlob } from "eve/memory/file/vercel";
import { documentRepository } from "eve/extensions/custom-skills/repository";

const skills = documentRepository({ backend: vercelBlob(), namespace: "support-agent" });
for (const scope of (await skills.listScopes?.()) ?? []) {
  const { heads } = await skills.listHeads(scope);
  console.log(
    scope.name,
    scope.label,
    heads.map(({ id, name, liveVersion }) => ({ id, name, liveVersion })),
  );
}
```

Catalog writes are compare-and-swap, and the catalog's version is the scope's revision, so concurrent saves get distinct version numbers and limit checks can't race. Deleting a skill overwrites its version documents with an empty tombstone, because memory document backends have no delete; a backend that keeps object history still holds the old content.

To keep skills elsewhere, implement `SkillRepository` from `eve/extensions/custom-skills/repository` and pass it as `repository`. Heads carry an `id`; `appendVersion` passes a fresh UUID for a new skill, which a repository may store or replace with its own ID returned in `head.id`. Names are unique per scope: reject a new skill whose name is taken with `SkillConflictError`. Versions are numbered 1, 2, 3… with no gaps. `listHeads` returns the scope's `revision`, which changes on every write; reject a write whose `expectedRevision` is stale with `SkillConflictError`, and the lifecycle checks its limits again and retries. That keeps concurrent writers in a shared scope from exceeding the skill and always-on limits, or changing the mode of a version published in the meantime. Also throw `SkillConflictError` from `appendVersion` when the latest version isn't the expected one, and `SkillNotFoundError` from `updateHead` for a missing skill. Implement the optional `listScopes` to make the store scannable.

## Validate

```sh
pnpm --filter @eve/custom-skills typecheck
pnpm --filter @eve/custom-skills test
```
