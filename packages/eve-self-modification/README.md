# @eve/self-modification

A source-editing subagent for [eve](https://eve.dev). It edits the authored source tree during local development and can propose changes through draft pull requests from supported production builds.

Install the package and scaffold the subagent from the eve registry:

```sh
eve add experimental/self-modification
```

The command creates an agent, sandbox, extension, and one shared `config.ts` module. Interactive setup can keep editing local, configure a Git-connected Vercel deployment, or print the requirements for a CI or self-hosted deployment:

```text
agent/subagents/self-modification/
├── agent.ts
├── config.ts
├── sandbox.ts
└── extensions/
    └── selfmod.ts
```

## Configuration

`config.ts` controls both self-modification capabilities. Local source editing is enabled by default. Set `development.enabled` to `false` to disable it. Omit either `source` or `change` to disable self-modification in deployed applications.

```ts
import { defineSelfModificationConfig } from "@eve/self-modification/config";

export default defineSelfModificationConfig({
  development: {
    enabled: false,
  },
  source: {
    git: {
      repository: "github.com/acme/support-agent",
    },
  },
  change: {
    behavior: "review",
    branch: "main",
  },
});
```

- `development.enabled` controls direct edits while running `eve dev`; it defaults to `true`.
- `source.git` fixes the only repository the deployed workflow may access. The initial implementation supports `github.com/owner/repo`.
- `change.behavior: "review"` publishes a provider-native review request; a GitHub source creates a draft pull request. `change.branch` is its target branch.

Each generated definition receives the same configuration:

```ts
// agent.ts
import { defineSelfModificationAgent } from "@eve/self-modification/agent";
import config from "./config";

export default defineSelfModificationAgent({
  config,
  model: "openai/gpt-5.6-terra",
});

// sandbox.ts
import { defineSelfModificationSandbox } from "@eve/self-modification/sandbox";
import config from "./config";

export default defineSelfModificationSandbox({ config });

// extensions/selfmod.ts
import selfModification from "@eve/self-modification";
import config from "../config";

export default selfModification(config);
```

In local development, the sandbox mounts the application’s authored `agent/` directory read-write at `/source` and the installed eve documentation read-only at `/eve-docs`. The extension contributes `selfmod__edit_file` and `selfmod__search_registry`.

## Draft pull requests from production builds

`source` and `change` make a production build eligible for draft pull requests; configuration alone does not expose the subagent. eve requires matching deployment source metadata and `EVE_SELF_MODIFICATION_GITHUB_TOKEN` before exposing it. Preparing a proposal also requires a process-capable sandbox. The subagent remains hidden when source metadata is absent, incomplete, unsupported, or identifies a different repository, and when the GitHub credential is absent.

The guided Vercel path requires a Git-connected Vercel project backed by the configured GitHub repository. Vercel supplies the source metadata and Vercel Sandbox. A non-Git-connected CLI deployment does not necessarily receive Git metadata and is not covered by this path.

For CI or self-hosted builds, set complete source metadata in the trusted environment that runs `eve build`:

```sh
EVE_SOURCE_REPOSITORY=github.com/acme/support-agent
EVE_SOURCE_REVISION="$CI_COMMIT_SHA"
EVE_SOURCE_ROOT=apps/support-agent
```

Map `EVE_SOURCE_REVISION` to the immutable commit variable supplied by your CI system. `EVE_SOURCE_ROOT` is the application path relative to the repository root, or `.` for an application at the root. Also configure `sandbox.ts` with a process-capable Docker, microsandbox, or custom backend. Runtime-only `EVE_SOURCE_*` values are too late because eve captures them during the production build.

Use a fine-grained personal access token restricted to the configured repository with **Contents: read and write**, **Pull requests: read and write**, and **Metadata: read**. Store it in `EVE_SELF_MODIFICATION_GITHUB_TOKEN`. The package resolves this fixed environment variable only during trusted checkout and publication. The token never appears in sandbox commands, authored source, prompts, tool output, or durable state.

On a supported deployment, every accepted session can request a draft pull request, including anonymous sessions accepted by public routes. Protect inbound routes and channels before enabling it. Creating a proposal may trigger CI, previews, bots, notifications, and paid compute.

The sandbox checks out the configured pull request base for edits and the exact deployed revision for inspection. The publisher can create only a namespaced branch and draft pull request. It cannot update the base branch, merge, approve, close, or retarget a pull request. Repository review, merge, and redeployment remain separate authorization boundaries.
