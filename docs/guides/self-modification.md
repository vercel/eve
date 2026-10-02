---
title: "Self-Modification"
description: "Ask your agent to update its own authored files during local development, or let a deployed agent propose changes as draft pull requests."
---

When `eve dev` starts a local server, it mounts the bundled self-modification extension by default. Ask your agent to change its instructions, tools, skills, or other files under `agent/`; eve delegates the source work to the `self-modification__agent` subagent. Connecting to an existing server with `eve remote connect --url <url>` does not add the bundled extension to that server.

The bundled extension is `eve/self-modification/local`. It is for local development and is not included in production builds. To let a deployed agent propose source changes, mount the separate [`eve/self-modification/deployed`](#propose-changes-from-a-deployed-agent) extension.

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

Mounts that import `eve/self-modification` still work; that specifier is an alias for `eve/self-modification/local`. Neither specifier accepts a `deployed` option. If your mount sets `deployed`, eve rejects it and asks you to move that configuration to an `eve/self-modification/deployed` mount.

## Propose changes from a deployed agent

`eve/self-modification/deployed` is a separate extension for deployed agents. Outside `eve dev`, it delegates repository work to a coding subagent that proposes changes as draft pull requests. It never changes the running agent. Changes take effect only after you review, merge, and deploy them.

Mount it under its own namespace so it does not replace the local extension:

```ts
// agent/extensions/self-modification-deployed/extension.ts
import selfModification from "eve/self-modification/deployed";

export default selfModification({
  authorize: ({ principal }) => principal?.principalId === "trusted-editor",
  github: { repository: "acme/agents", connector: "github/agent-author" },
  directory: "apps/support",
  baseBranch: "main",
});
```

This mount adds the `self-modification-deployed__agent` subagent. The extension accepts:

- `authorize` (required): decides whether the current caller can delegate to the coding subagent.
- `github.repository` (required): the repository to check out and open pull requests against, in `owner/repo` form.
- `github.connector` (required): the GitHub Vercel Connect connector that provides repository credentials.
- `directory`: the application directory relative to the repository root. Defaults to `"."`.
- `baseBranch`: the branch pull requests target. Defaults to `"main"`.
- `model` and `reasoning`: the coding subagent's model and reasoning level. The model defaults to the parent agent's model.

The deployed subagent is never offered during `eve dev`, where the local extension handles source edits.

### Authorize callers

`authorize` receives the current authenticated `principal`, or `null` for anonymous callers, and the request's `channel` kind and metadata. Return `true` to offer the coding subagent. Returning `false` or throwing hides it, and eve logs the thrown error. The callback runs on session start and on each turn, including follow-ups.

The principal ID in the example is illustrative. Check the identities your channel produces before you write a policy.

### Connect GitHub

Create a GitHub Vercel Connect connector, attach it to the deployed project, and install it on the configured repository. Grant the repository permissions needed to read source, push branches, and create pull requests. Use repository rules to require review on protected branches.

### Sandbox and checkout

The deployed subagent's sandbox runs on Vercel Sandbox, or on microsandbox for self-hosted deployments. On other hosts, delegation fails with an error naming the supported providers.

The sandbox checks out the repository to `/workspace/repository`, which must contain the configured application and its `agent/` directory. The subagent installs dependencies when needed, using the repository's package manager and lockfile. The project `eve` CLI is available after installation; in a monorepo, it may live at the workspace root. Private packages need their own installation credentials because the sandbox does not inherit host credentials.

### Request a change

Ask for persistent changes in ordinary terms, such as “Replace your hardcoded weather tool with a live weather API.” The parent delegates the work to the coding subagent, which has its own checkout, so the source does not need to exist in the parent's sandbox.

Questions, investigations, and design requests are read-only. An explicit implementation request authorizes the subagent to push a branch and open a draft PR. It may edit any file in the repository; the application directory gives it context.

Follow-up turns continue the same subagent and reuse its checkout. Independent requests use a separate subagent. A draft PR does not change the running agent: review and merge it, then deploy.

To add a registry capability, the subagent searches with `eve registry search "slack" --json` and installs source with `eve add channel/slack --non-interactive --skip-setup`. Complete OAuth, secret binding, and other external setup after you review and deploy the change. The subagent's handoff lists the PR URL, the checks it ran, and any remaining setup.

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
