---
title: "Self-Modification"
description: "Ask your agent to update its own authored files during local development, or let a deployed agent propose changes as draft pull requests."
---

When `eve dev` starts a local server, it mounts the bundled self-modification extension by default. Ask your agent to change its instructions, tools, skills, or other files under `agent/`; eve delegates the source work to the `self-modification__agent` subagent. Connecting to an existing server with `eve remote connect --url <url>` does not add the bundled extension to that server.

The bundled extension is `eve/self-modification/local`. It is for local development and is not included in production builds. To let a deployed agent propose source changes, mount the separate [`eve/self-modification/remote`](#propose-changes-from-a-deployed-agent) extension.

```bash
eve dev
```

For example, ask the agent to add a reusable action:

```text
Add a tool that converts temperatures between Celsius and Fahrenheit.
```

The self-modification subagent changes the authored files in your project. Review the diff and test the new behavior as you would for any other source change. `eve dev` reloads changes while you work.

## Change the self-modification model

The subagent uses your agent's model by default. To give it a different model or reasoning level, ask for it directly:

```text
Switch the self-modification subagent to openai/gpt-6-sol with low reasoning.
```

The first time, this creates `agent/extensions/self-modification/extension.ts` with those settings. After that file exists, later changes edit it. You can also edit the file yourself: it accepts `model`, `reasoning`, and `local.enabled` options.

```ts
// agent/extensions/self-modification/extension.ts
import selfModification from "eve/self-modification/local";

export default selfModification({
  model: "openai/gpt-6-sol",
  reasoning: "low",
});
```

Mounts that import `eve/self-modification` still work; that specifier is an alias for `eve/self-modification/local`. Neither specifier accepts a `deployed` option. If your mount sets `deployed`, eve rejects it and asks you to move that configuration to an `eve/self-modification/remote` mount.

## Propose changes from a deployed agent

`eve/self-modification/remote` is a separate extension for deployed agents. It adds a subagent that checks out your repository in a sandbox, edits the authored source, and opens a draft pull request against a target branch. It never changes the running deployment. Changes take effect only after you review, merge, and redeploy.

Mount it under its own namespace so it does not replace the local extension:

```ts
// agent/extensions/self-modification-remote/extension.ts
import selfModification from "eve/self-modification/remote";

export default selfModification({
  source: {
    git: {
      repository: "github.com/acme/agents",
      directory: "apps/support",
    },
  },
  target: { branch: "main" },
  credentials: { pat: true },
  authorize: ({ channel, principal }) =>
    channel.kind === "http" && principal?.principalId === "release-bot",
});
```

| Option                  | Description                                                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source.git.repository` | GitHub repository in `github.com/owner/repo` form.                                                                                                                                                      |
| `source.git.directory`  | Application directory relative to the repository root. Use `"."` for the root.                                                                                                                          |
| `target.branch`         | Branch that is checked out and targeted by draft pull requests.                                                                                                                                         |
| `authorize`             | Required. Receives the requesting `channel` and `principal` and returns whether that caller can use the subagent. The subagent is hidden when it returns `false` or throws.                             |
| `credentials`           | Required. An object with a `resolve({ capability, repository })` function that returns a GitHub token, or `{ pat: true }` to read `EVE_SELF_MODIFICATION_GITHUB_TOKEN` from the deployment environment. |
| `model`, `reasoning`    | Optional model and reasoning level for the deployed subagent. It defaults to the parent agent's model.                                                                                                  |

The deployed subagent is never offered during `eve dev`. In a deployment, it needs a sandbox provider that supports runtime credential transforms: Vercel Sandbox on Vercel, or microsandbox on a supported self-hosted system. eve applies the GitHub token as a sandbox network credential only while it checks out or publishes, so commands in the sandbox cannot read it.

## Run without self-modification

Pass `--no-default-extensions` when you do not want `eve dev` to mount bundled development extensions:

```bash
eve dev --no-default-extensions
```

This disables the complete bundled default set for that server, including self-modification. It does not remove files from your project or disable extensions that you have explicitly mounted under `agent/extensions/`.

## What to read next

- [Terminal UI](./dev-tui): work with your agent locally.
- [Instructions](../instructions): define the agent's behavior.
- [Tools](../tools): add model-callable actions.
- [Skills](../skills): give the agent reusable procedures.
