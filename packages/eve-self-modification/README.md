# @eve/self-modification

`@eve/self-modification` is a compatibility package. New applications should install the self-modification extension included with `eve`:

```sh
eve add eve/self-modification
```

The command creates `agent/extensions/self-modification/extension.ts`:

```ts
import selfModification from "eve/self-modification";

export default selfModification({
  // model: "provider/model",
  // reasoning: "high",
});
```

Local source editing is available while `eve dev` is running, and registry installation adds only `just-bash`. The registry command runs local-only setup; deployed-aware setup remains a separate integration. Keep the generated mount at `agent/extensions/self-modification/extension.ts`; alternate mount paths and namespaces are not supported by the self-modification setup and TUI flows.

## Migrate a scaffolded subagent

Older installations placed self-modification under `agent/subagents/self-modification/`. That scaffold is retired: its agent helper is unavailable, and its sandbox helper is inert.

Run the registry command to install the packaged extension:

```sh
eve add eve/self-modification
```

When setup detects a retired scaffold, it offers to remove the entire legacy directory and selects **Yes** by default. Decline the prompt if you need to inspect those files before removing them.

The legacy `eve/self-modification/agent`, `eve/self-modification/sandbox`, and `eve/self-modification/config` entrypoints remain available so the standard scaffold can build during migration. Do not use the retired agent or sandbox helpers for new installations.
