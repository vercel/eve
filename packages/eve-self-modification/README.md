# @eve/self-modification

A source editing subagent for [eve](https://eve.dev). It edits the authored source tree directly in development and proposes draft pull requests in configured deployments.

Install the package and scaffold a development self-modification subagent from the eve registry:

```sh
eve add experimental/self-modification
```

The command creates independent filesystem entrypoints for the subagent, sandbox, and extension:

```text
agent/subagents/self-modification/
├── agent.ts
├── sandbox.ts
└── extensions/
    └── selfmod.ts
```

```ts
// agent/subagents/self-modification/agent.ts
import { defineSelfModificationAgent } from "@eve/self-modification/agent";

export default defineSelfModificationAgent({
  model: "openai/gpt-5.6-terra",
});

// agent/subagents/self-modification/sandbox.ts
export { default } from "@eve/self-modification/sandbox";

// agent/subagents/self-modification/extensions/selfmod.ts
export { default } from "@eve/self-modification";
```

Set `model` in the agent definition to choose the self-modification subagent's model; it defaults to `anthropic/claude-sonnet-5`. In development, the sandbox mounts the application's authored `agent/` directory read-write at `/source` and the installed eve package's version-matched documentation read-only at `/eve-docs`.

The extension contributes `selfmod__edit_file` for exact targeted edits and `selfmod__search_registry` for finding channels, connections, extensions, and other integrations. Registry installation remains outside the source sandbox: the subagent reports an exact item address for the developer to install with `/add <address>`.

## Production proposals

Production configuration is shared by direct agent, sandbox, and extension definitions. Add `agent/subagents/self-modification/git.ts`:

```ts
export const production = {
  environments: ["production"],
  repository: "acme/support-agent",
  baseBranch: "main",
} as const;
```

Then pass that policy to each definition:

```ts
// agent/subagents/self-modification/agent.ts
import { defineSelfModificationAgent } from "@eve/self-modification/agent";
import { production } from "./git";

export default defineSelfModificationAgent({
  model: "openai/gpt-5.6-terra",
  production,
});

// agent/subagents/self-modification/sandbox.ts
import { defineSelfModificationSandbox } from "@eve/self-modification/sandbox";
import { production } from "./git";

export default defineSelfModificationSandbox({ production });

// agent/subagents/self-modification/extensions/selfmod.ts
import selfModification from "@eve/self-modification";
import { production } from "../git";

export default selfModification({ production });
```

Local development continues to edit the authored source tree directly when production is configured. In enabled deployments, the sandbox checks out the configured pull request base and exact deployed revision; the extension contributes production instructions and a trusted draft pull request publisher.

Use a fine-grained personal access token restricted to the configured repository with **Contents: read and write**, **Pull requests: read and write**, and **Metadata: read**. Store it in `EVE_SELF_MODIFICATION_GITHUB_TOKEN`. The package resolves this fixed environment variable only at trusted checkout and publication boundaries. Checkout receives the token through transient network-policy injection; the policy returns to deny-all before model editing begins. The token never appears in sandbox commands, authored source, prompts, tool output, or durable state.

Production is disabled when `production` is absent. The configured repository must match trusted deployment source metadata, the current deployment environment must appear in `production.environments`, and a VM or container sandbox must be available. Vercel deployments infer their environment and use Vercel Sandbox.

A self-hosted deployment supplies its environment label in the shared policy and its backend in the sandbox definition:

```ts
// git.ts
export const production = {
  environment: "production",
  environments: ["production"],
  repository: "acme/support-agent",
  baseBranch: "main",
} as const;

// sandbox.ts
import { defineSelfModificationSandbox } from "@eve/self-modification/sandbox";
import { production } from "./git";

export default defineSelfModificationSandbox({
  backend: mySandboxBackend,
  production,
});
```

This version does not apply principal authorization rules. Every session accepted by an enabled deployment can request a draft pull request, including anonymous sessions accepted by public routes. Protect inbound routes and channels before enabling production self-modification. Creating a proposal may trigger CI, previews, bots, notifications, and paid compute.

The trusted publisher can create only a namespaced branch and draft pull request. It cannot update the base branch, merge, approve, close, or retarget a pull request. Self-modification enforces repository, ancestry, path, size, file-kind, and diff-integrity checks before publication. Repository CI performs project-specific validation after publication, and repository review and merge remain separate authorization boundaries.
