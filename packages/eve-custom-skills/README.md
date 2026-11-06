# eve/extensions/custom-skills

`eve/extensions/custom-skills` lets the people talking to an agent save their own skills: personal skills that follow a user everywhere, and channel skills shared by everyone in a Slack channel.

It ships inside the `eve` package. This private `@eve/custom-skills` workspace package is its source of truth: eve's build copies `extension/` into `packages/eve/src/extensions/custom-skills/extension` and publishes it as `eve/extensions/custom-skills`.

- **Immutable versions, one live version.** A clean first version goes live. Later saves are drafts until `publish`, and `rollback` makes an exact earlier version live again. A version's status follows from the live version: `active`, `superseded` below it, `draft` above it.
- **Three application modes.** `always` injects the skill into the system prompt every turn. `on-demand` lists it for `eve__skill`. `deferred` keeps it out of the prompt until `eve__search` finds it.
- **Validation.** On-demand and deferred descriptions must be routing conditions ("Use when the user asks…"). Size and control-character limits block a save. Instructions that try to override or bypass higher-priority rules raise warnings, which hold a first version in draft.
- **Approval.** `publish`, `rollback`, and `remove` use eve's `always()` approval.

## Mount

```ts
// agent/extensions/skills.ts
import customSkills from "eve/extensions/custom-skills";

export default customSkills({});
```

With `BLOB_READ_WRITE_TOKEN` (or `BLOB_STORE_ID` plus Vercel OIDC) set, that is all. Without storage, no custom skills load and the tools say storage is missing. For local development, pass `storage: inMemory()` from `eve/memory/file`.

The mount name prefixes everything. Mounted as `skills`, the agent gets `skills__create`, `skills__list`, `skills__read`, `skills__versions`, `skills__publish`, `skills__rollback`, `skills__set_mode`, `skills__remove`, the `skills__manage` lifecycle skill, and user skills that load as `skills__<name>` (personal) or `skills__channel-<name>` (channel). The prefix means a user's skill can never shadow one of the agent's own skills. Keep the mount name to 14 characters or fewer so `<mount>__channel-<name>` fits eve's 64-character skill name limit.

## Configure

| Option       | Default                               | Purpose                                                                                                |
| ------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `storage`    | Vercel Blob when configured           | Any `MemoryDocumentBackend` from `eve/memory/file`, such as `vercelBlob()` or `inMemory()`.            |
| `repository` | none                                  | Your own `SkillRepository`, such as database tables. Takes precedence over `storage`.                  |
| `scopes`     | personal + Slack channel              | Returns the turn's `SkillScope`s in precedence order. The first is the default scope for the tools.    |
| `limits`     | 5 always-on skills, 20,000 characters | Caps per scope, so always-on skills can't flood the prompt.                                            |
| `onChange`   | none                                  | Runs after each save, publish, mode change, or delete. Failures are logged, not surfaced to the model. |

The default scope resolver gives every caller with an eve principal a personal scope keyed by `principalId`, and adds a `channel` scope when eve's Slack channel reports a non-DM `channel_id`. Supply your own resolver for other surfaces or scheduled runs.

## Storage

The default store keeps one catalog document per scope, holding every skill's live version, mode, and version index, plus one document per version. Catalog writes are compare-and-swap, so concurrent saves get distinct version numbers. Deleting a skill overwrites its version documents with an empty tombstone, because memory document backends have no delete.

To keep skills elsewhere, implement `SkillRepository` (seven methods over skill heads and immutable versions) and pass it as `repository`. The lifecycle never looks inside the scope, and a repository may assign its own ids; the built-in tools address skills by name.

## Validate

```sh
pnpm --filter @eve/custom-skills typecheck
pnpm --filter @eve/custom-skills test
```
