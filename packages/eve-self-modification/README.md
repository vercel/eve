# @eve/self-modification

`@eve/self-modification` is a compatibility package. New applications should install the self-modification extension included with `eve`:

```sh
eve add eve/self-modification
```

The command creates `agent/extensions/self-modification/extension.ts`:

```ts
import selfModification from "eve/extensions/self-modification/local";

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

Setup rejects the retired layout without deleting it. Preserve any authored changes, remove `agent/subagents/self-modification/`, then run the registry command to install the local extension mount.

The bare `eve/self-modification` import and `/config` entry are removed. The agent and sandbox integration helpers live under `eve/internal/self-modification/`; they have no compatibility promise and are not authoring APIs.
