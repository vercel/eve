---
title: "Self-Modification"
description: "Ask your agent to update its own instructions, tools, skills, and other authored files during local development."
---

`eve dev` includes self-modification by default. Ask your agent to change its instructions, tools, skills, or other files under `agent/`; eve delegates the source work to a bundled subagent.

```bash
eve dev
```

For example, ask the agent to add a reusable action:

```text
Add a tool that converts temperatures between Celsius and Fahrenheit.
```

The self-modification subagent changes the authored files in your project. Review the diff and test the new behavior as you would for any other source change. `eve dev` reloads changes while you work.

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
