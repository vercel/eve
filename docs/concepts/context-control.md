---
title: "Context Control"
description: "Control what an eve agent's model sees and when, across instructions, skills, the workspace, and subagents."
---

eve gives you a few levers for controlling what the model sees and when. `instructions.md` (or `instructions.ts`) is always on, `skills/` are available but loaded on demand, and the workspace and sandbox are visible through tools rather than pasted into the prompt.

## Base identity with `instructions.md`

Use `instructions.md` for the core contract of the agent.

```md
You are a careful support assistant. Be concise, verify facts before replying, and explain when you
used a tool.
```

Keep this file focused on stable behavior that should apply on every turn.

## Compose instructions in TypeScript with `instructions.ts`

To build the instructions prompt from typed helpers, lib code, or environment-derived values, author it as a module instead of markdown.

```ts title="agent/instructions.ts"
import { defineInstructions } from "eve/instructions";
import { buildInstructionsPrompt } from "./lib/prompts.js";

export default defineInstructions({
  markdown: buildInstructionsPrompt(),
});
```

Module-backed instructions run once at build time. eve captures the resulting markdown into the compiled manifest, so the runtime serves the same prompt every session without re-running the module.

## Load procedures on demand with `skills/`

Skills stay out of the always-on prompt by default, which keeps rich procedures available without bloating every turn. eve advertises the available skills and adds a framework-owned `load_skill` tool. When the request clearly matches a skill description, or the user names a skill explicitly, the model activates that skill, and eve appends the skill's markdown to the active instructions for later turn work.

### Flat skill

```md title="agent/skills/get-weather.md"
Use the weather tool before answering forecast or temperature questions.
```

### Packaged skill

```md title="agent/skills/research/SKILL.md"
---
description: Research unfamiliar topics before answering with confidence.
---

When the task is novel or ambiguous, gather evidence first, then answer with the key facts and the
remaining uncertainty.
```

Packaged skills are useful when you also want sibling files such as `references/`, `assets/`, or `scripts/` under the same skill directory. Those paths show up under the runtime workspace root, so the model can inspect them with the normal file or shell tools instead of pasting their content into the prompt.

See [Skills](../skills) for the full authoring model and install notes.

## Put runtime files in the workspace, not the prompt

eve does not inline the entire authored surface into the prompt. Instead, it gives the model a shallow workspace hint and runtime tools to inspect deeper when needed. Skill files are available under the active workspace root, and the model inspects them with the shared `bash` tool, which keeps prompts smaller and makes file and command work explicit.

See [Sandbox](../sandbox) for the workspace and sandbox model.

## Delegate to a specialist with a subagent

If a task deserves its own prompt and tool surface, use a local subagent instead of overloading the root agent. Subagents are a context-control lever too. They get their own `instructions.md`, tools, and sandbox, and they run inside their own delegated context instead of extending the root agent inline.

See [Subagents](../subagents).

## Dynamic context with `defineDynamic`

The levers above are static, authored once and the same on every session. When the right context depends on who is calling (their team, tenant, plan, or feature flags), resolve it at runtime instead. `defineDynamic` in `agent/instructions/` returns the per-session system prompt, and `defineDynamic` in `agent/skills/` returns the set of skills a caller can load. Both read `ctx.session.auth` or channel metadata, so a caller on the billing team gets the billing instructions and playbook while no one else sees them. See [Dynamic capabilities](../guides/dynamic-capabilities) for the resolver API and when each event fires.

## Recommended context layout

Pick the lever by what the context is for:

- `instructions.md` for the agent's permanent identity. Keep it short and stable.
- `instructions.ts` when you need to compose the prompt from typed helpers at build time.
- `skills/` for optional procedures that should load only when needed. Move long procedures here instead of into the always-on prompt.
- `tools/` to expose typed integrations.
- a subagent when the task needs a different specialist surface; use one only for real specialization boundaries.
- the workspace or sandbox when the model should inspect files or run commands instead of relying on pasted instructions.

## What to read next

- [Tools](../tools): expose typed integrations the model can call.
- [Skills](../skills): the full authoring model for on-demand procedures.
- [Subagents](../subagents): delegate to a specialist with its own prompt and tools.
- [Dynamic capabilities](../guides/dynamic-capabilities): resolve per-session instructions and skills with `defineDynamic`.
- [Hooks](../guides/hooks): run code on session events to update the channel state that dynamic resolvers read.
