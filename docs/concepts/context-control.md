---
title: "Context Control"
description: "Choose what an eve agent's model sees and when, across instructions, skills, tools, the workspace, and subagents."
---

Control context by putting information in the narrowest surface that needs it. Keep permanent rules in instructions, load optional procedures as skills, let the model inspect runtime files through sandbox tools, and delegate specialist work to a subagent.

## Recommended context layout

| Need                                                 | Use                                                    | What the model sees                                                              |
| ---------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Permanent identity, rules, or constraints            | System-role [instructions](../instructions)            | System context on every model call                                               |
| Durable application or retrieved context             | User-role [instructions](../instructions)              | A message added to conversation history at its lifecycle boundary                |
| A procedure needed only for some tasks               | A [skill](../skills)                                   | Its description until the model loads the full skill                             |
| A typed action or external operation                 | A [tool](../tools) or [connection](../connections)     | The callable schema and the result of each call                                  |
| Files or command execution                           | The [sandbox workspace](../sandbox)                    | A workspace hint, then files and command output the model requests through tools |
| A specialist with a separate prompt and capabilities | A [subagent](../subagents)                             | The child's reply as the tool result                                             |
| Instructions or capabilities that vary by caller     | A [dynamic capability](../guides/dynamic-capabilities) | The values resolved for the active session                                       |
| Scoped context retrieved from cross-session storage  | [Memory](../memory)                                    | Attributed user-role messages recalled before the current delivery               |

## Base identity with `instructions.md`

Use system-role instructions for stable behavior that should apply throughout a session, such as the agent's role, tone, and standing constraints. Markdown is the default. Keep instructions short enough to justify including them on every model call.

### Compose instructions in TypeScript with `instructions.ts`

Use `instructions.ts` when you need typed helpers, build-time composition, or a user-role message. User-role instructions become ordinary durable history rather than system context. See [Instructions](../instructions) for both formats, directory composition, and runtime resolution.

## Load procedures on demand with `skills/`

Use skills for optional procedures that would otherwise make the always-on prompt unnecessarily large. eve advertises each skill's description and loads the full instructions only when the model calls `eve__skill({ name })`. A deferred skill isn't named in context, so even its description stays out of context until the model searches for it.

### Flat skill

Use a markdown file for a self-contained procedure.

### Packaged skill

Use a directory with `SKILL.md` when the procedure also needs references, assets, or scripts. See [Skills](../skills) for both formats, installation, runtime files, and dynamic skills.

## Put runtime files in the workspace, not the prompt

Do not paste a file tree or large working dataset into the prompt. Seed files into the sandbox workspace and let the model inspect them through `bash`, `read_file`, `glob`, and the other sandbox-backed tools. Skill package files use a separate runtime skill directory.

See [Sandbox](../sandbox) for workspace seeding, runtime access, backends, and lifecycle behavior.

## Delegate to a specialist with a subagent

Use a subagent when work needs its own instructions, tools, skills, state, or sandbox. The child runs in a separate context instead of adding its working history to the parent. The call waits for the child's reply and returns it as the tool result.

See [Subagents](../subagents) for the distinction between root-agent copies and declared specialists, including their isolation boundaries.

## Dynamic context with `defineDynamic`

Use `defineDynamic` when instructions, skills, tools, subagents, or the model depend on the active principal, tenant, channel, conversation, or feature state. The function reads the committed session and returns the capability or `null`. eve evaluates it before each ordinary model call; `ctx.memo(key, fn)` keeps JSON observations across evaluations.

See [Dynamic capabilities](../guides/dynamic-capabilities) for the context, memo rules, supported folders, and evaluation timing.

## Compaction and clear

Before a model call, eve checks the projected history together with the effective system instructions and advertised tool schemas. The check runs after eve evaluates dynamic capabilities for that call. When the provider reports input usage, eve adds estimates for new messages and growth in the instructions and tool catalog to that count; unchanged schemas are not counted again.

Compaction reserves space for those instructions and tools while reducing conversation history. It cannot shrink the instructions or tool catalog themselves, so keep them within the selected model's context window.

User-role instructions follow the normal history lifecycle. Compaction can summarize them, and clear removes them without rerunning their static definitions or dynamic definitions. System-role instructions remain outside history and continue to apply after either operation.

Recalled memory stays outside history too. eve recalls before the first model call of each turn, and every later model call reads that turn's recall just ahead of the turn's input. Compaction does not summarize it; a provider can capture before compaction rewrites history. Clear drops what earlier turns recalled, though not the provider's external data, and the next turn recalls again.

## What to read next

- [Instructions](../instructions): author the always-on system prompt.
- [Skills](../skills): provide procedures that load on demand.
- [Sandbox](../sandbox): give the model files and command execution.
- [Subagents](../subagents): isolate specialist work.
- [Dynamic capabilities](../guides/dynamic-capabilities): vary context and capabilities by session.
- [Memory](../memory): retrieve scoped context from storage that outlives a session.
