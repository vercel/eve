---
title: "Self-Modification"
description: "Ask your agent to update its own authored files during local development, or let a deployed agent propose changes as draft pull requests."
---

Self-modification lets you ask your agent to change its own instructions, tools, skills, or other files under `agent/`. When `eve dev` starts a local server, it mounts the bundled `eve/extensions/self-modification/local` extension, which delegates the source work to the `self-modification__agent` subagent. `eve remote connect --url <url>` doesn't add it to the server it connects to.

The local extension is not included in production builds. To let a deployed agent propose source changes, mount the separate [`eve/extensions/self-modification/remote`](#propose-changes-from-a-deployed-agent) extension.

```bash
eve dev
```

For example, ask the agent to add a reusable action:

```text
Add a tool that converts temperatures between Celsius and Fahrenheit.
```

The subagent edits the authored files in your project, and `eve dev` reloads them. Review the diff and test the change as you would any other source change.

The subagent is offered only to sessions authenticated by [`localDev()`](./auth-and-route-protection#localdev) or by the Vercel development token the dev TUI sends for a linked project. Sessions authenticated any other way, such as Slack users or HTTP Basic operator credentials, don't see it, and the local mount has no `authorize` override.

A tunnel or reverse proxy on the same machine can forward callers that `localDev()` accepts as the local developer. Those callers can use the subagent. Before exposing `eve dev` through a tunnel, require authentication at the tunnel or proxy, or remove `localDev()` from the exposed channel's auth chain. Another authenticator placed before `localDev()` doesn't help, because callers it skips still fall through to `localDev()`.

## Change the self-modification model

The subagent uses your agent's model by default. To give it a different model or reasoning level, ask for it directly:

```text
Switch the self-modification subagent to openai/gpt-6-sol with low reasoning.
```

This creates or edits `agent/extensions/self-modification/extension.ts`. You can also edit the file yourself; it accepts `model`, `reasoning`, and `local.enabled`.

```ts
// agent/extensions/self-modification/extension.ts
import selfModification from "eve/extensions/self-modification/local";

export default selfModification({
  model: "openai/gpt-6-sol",
  reasoning: "low",
});
```

The local mount rejects a `deployed` option with an error; configure deployed source changes on a separate `eve/extensions/self-modification/remote` mount.

## Propose changes from a deployed agent

`eve/extensions/self-modification/remote` adds a source-change subagent to a deployed agent. The subagent checks out your repository in a sandbox, edits the authored source, and opens a draft pull request against a target branch. It never changes the running deployment; changes take effect after you review, merge, and redeploy.

Mount it under its own namespace so it doesn't replace the local extension:

```ts
// agent/extensions/self-modification-remote/extension.ts
import selfModification from "eve/extensions/self-modification/remote";

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
    channel.kind === "channel:eve" && principal?.principalId === "release-bot",
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

The deployed subagent is never offered during `eve dev`. It requires Vercel, because Vercel Sandbox keeps the GitHub token out of the sandbox. eve applies the token only while it checks out or publishes, so sandbox commands can't read it. Builds succeed on any host. Outside Vercel, the subagent fails with an error naming this requirement when it opens its sandbox, so don't mount it in self-hosted deployments.

## Run without self-modification

Pass `--no-default-extensions` to stop `eve dev` from mounting its bundled development extensions:

```bash
eve dev --no-default-extensions
```

This disables every bundled default extension for that server, including self-modification. Extensions you mount under `agent/extensions/` still load.

## Troubleshooting

| What you see                                                                             | What to do                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `The legacy agent/subagents/self-modification layout is no longer supported.` from setup | Keep any authored changes, remove `agent/subagents/self-modification/`, then run `eve add eve/self-modification` to mount the extension at `agent/extensions/self-modification/extension.ts`. |

## What to read next

- [Terminal UI](./dev-tui): work with your agent locally.
- [Instructions](../instructions): define the agent's behavior.
- [Tools](../tools): add model-callable actions.
- [Skills](../skills): give the agent reusable procedures.
