---
title: "Self-Modification"
description: "Ask your agent to update its own authored files during local development, or let a deployed agent propose changes as draft pull requests."
---

When `eve dev` starts a local server, it mounts the bundled self-modification extension by default. Ask your agent to change its instructions, tools, skills, or other files under `agent/`; eve delegates the source work to the `self-modification__agent` subagent. Connecting to an existing server with `eve remote connect --url <url>` does not add the bundled extension to that server.

The bundled extension is `eve/self-modification/local`. It is for local development and is not included in production builds. To let a deployed agent propose source changes, mount the separate [`eve/self-modification/remote`](#propose-changes-from-a-deployed-agent-experimental) extension.

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

## Run without self-modification

Pass `--no-default-extensions` when you do not want `eve dev` to mount bundled development extensions:

```bash
eve dev --no-default-extensions
```

This disables the complete bundled default set for that server, including self-modification. It does not remove files from your project or disable extensions that you have explicitly mounted under `agent/extensions/`.

## Propose changes from a deployed agent (Experimental)

`eve/self-modification/remote` is a separate extension for deployed agents. Outside `eve dev`, it delegates repository work to a coding subagent that proposes changes as draft pull requests. It never changes the running agent. Changes take effect only after you review, merge, and deploy them. Support is limited to repositories hosted by GitHub.

To configure it with guided setup, install the experimental registry item by its full name.

```bash
eve add experimental/self-modification/remote
```

The extension accepts:

- `authorize` (required): decides whether the current caller can delegate to the coding subagent.
- `github.repository` (required): the repository to check out and open pull requests against, in `owner/repo` form.
- `github.connector` (required): the GitHub Vercel Connect connector that provides repository credentials.
- `directory`: the application directory relative to the repository root. Defaults to `"."`.
- `baseBranch`: the branch pull requests target. Defaults to `"main"`.
- `model` and `reasoning`: the coding subagent's model and reasoning level. The model defaults to the parent agent's model.

The deployed subagent is never offered during `eve dev`, where the local extension handles source edits.

### Authorize callers

`authorize` receives the current authenticated `principal`, or `null` for anonymous callers, and the request's `channel` kind and metadata. Return `true` to offer the coding subagent. Returning `false` or throwing hides it, and eve logs the thrown error. The callback runs on session start and on each turn, including follow-ups.

Check the identities your channel produces before you write a policy.

### Connect GitHub

Create a GitHub Vercel Connect connector, attach it to the deployed project, and install it on the configured repository. Grant the repository permissions needed to read source, push branches, and create pull requests. Use repository rules to require review on protected branches.

## What to read next

- [Terminal UI](./dev-tui): work with your agent locally.
- [Instructions](../instructions): define the agent's behavior.
- [Tools](../tools): add model-callable actions.
- [Skills](../skills): give the agent reusable procedures.
