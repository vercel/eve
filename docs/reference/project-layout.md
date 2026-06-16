---
title: "Project Layout"
description: "Authored slots under agent/ and the path-derived naming rule."
---

eve builds an agent by walking the filesystem under `agent/`. Each directory is an authored slot, and the slot a file lands in determines how eve loads it.

## Naming rule

Identity comes from the path. You never write a `name` or `id` field on a `define*` call.

| Path                                  | Resolves to           |
| ------------------------------------- | --------------------- |
| `agent/tools/get_weather.ts`          | tool `get_weather`    |
| `agent/connections/linear.ts`         | connection `linear`   |
| `agent/skills/summarize.md`           | skill `summarize`     |
| `agent/subagents/researcher/agent.ts` | subagent `researcher` |

The root agent takes its name from the enclosing `package.json` `name`, falling back to the app-root directory name when `package.json` has no `name`. A subagent takes its name from its directory.

## Recommended layout

```text
my-agent/
├── package.json
├── tsconfig.json
├── agent/
│   ├── agent.ts
│   ├── instructions.md
│   ├── instrumentation.ts
│   ├── channels/
│   ├── connections/
│   ├── hooks/
│   ├── skills/
│   ├── lib/
│   ├── sandbox/
│   ├── tools/
│   ├── schedules/
│   └── subagents/
└── evals/
```

Evals live in `evals/` at the app root, a sibling of `agent/`, not inside it. See [Evals](../evals/overview).

## Slot table

The Subagents column states whether a local subagent (`subagents/<id>/`) can author the slot. A declared subagent inherits nothing from the root; it discovers its own slots. See [Subagents](../subagents).

| Path                                                    | Description                                 | Subagents | Notes                                                                                                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent.ts`                                              | Runtime config                              | Yes       | Model, modelOptions, compaction, build, experimental. See [Agent config](../agent-config).                                                                                                                            |
| `instructions.md` / `instructions.ts` / `instructions/` | Base system prompt                          | Optional  | A flat file, or a directory of `.md` and `.ts` files. Static sources compose at build time. Dynamic sources (`defineDynamic` + `defineInstructions`) resolve at runtime. Required on the root, optional on subagents. |
| `instrumentation.ts`                                    | Telemetry config                            | No        | OTel exporter and AI SDK span settings, auto-discovered and run before agent code. Root-only.                                                                                                                         |
| `channels/`                                             | HTTP / messaging entrypoints                | No        | Root-only.                                                                                                                                                                                                            |
| `connections/`                                          | External service connections (MCP, OpenAPI) | Yes       | One connection per file; name derived from filename.                                                                                                                                                                  |
| `hooks/`                                                | Lifecycle and stream-event subscribers      | Yes       | Module-backed only. Recursive directories supported.                                                                                                                                                                  |
| `skills/`                                               | On-demand procedures and capability packs   | Yes       | Flat markdown, module-backed skills, or packaged skills. Seeded into `/workspace/skills/...`.                                                                                                                         |
| `lib/`                                                  | Shared authored helper code                 | Yes       | Import-only; not mounted into the workspace.                                                                                                                                                                          |
| `sandbox.ts` or `sandbox/sandbox.ts`                    | The agent's single sandbox                  | Yes       | Use top-level `sandbox.ts` for a definition-only override; use `sandbox/sandbox.ts` + `sandbox/workspace/**` to also seed files. Framework default applies when neither is authored.                                  |
| `sandbox/workspace/**`                                  | Files seeded into the sandbox               | Yes       | Mirrored into `/workspace/...` at session bootstrap.                                                                                                                                                                  |
| `tools/`                                                | Typed executable integrations               | Yes       | Module-backed only.                                                                                                                                                                                                   |
| `schedules/`                                            | Recurring jobs                              | No        | Each schedule is `<name>.ts` (default-exported `defineSchedule`) or `<name>.md` (frontmatter `cron:` + prompt body). Recursive nesting supported. Root-only.                                                          |
| `subagents/`                                            | Specialist child agents                     | Yes       | Each child is its own local package under `subagents/<id>/`. Nested subagents are supported.                                                                                                                          |

## What reaches the runtime workspace

eve does not mount the whole tree. Only two sources land in the sandbox workspace:

- `skills/` files → `/workspace/skills/...`
- `agent/sandbox/workspace/**` → `/workspace/...` at session bootstrap

Everything in `lib/` stays import-only source code and never reaches the workspace.

## Local subagent layout

A local subagent lives under `subagents/<id>/` and uses the same `agent.ts` shape as the root.

```text
agent/subagents/researcher/
├── agent.ts
├── instructions.md
├── connections/
├── hooks/
├── skills/
├── lib/
├── sandbox/
├── tools/
└── subagents/
```

Rules:

- `agent.ts` is required, and must declare a `description`. The parent reads it on the lowered subagent tool to decide when to delegate.
- `instructions.md` / `instructions.ts` is optional (unlike the root agent, where it is required).
- `connections/`, `hooks/`, `skills/`, `lib/`, `sandbox/`, and `tools/` are all supported, discovered from the subagent's own directory.
- `channels/` and `schedules/` are not supported inside local subagents.
- Nested subagents are supported.

## Flat layout

Supported when the app root is also the agent root:

```text
my-agent/
├── package.json
├── agent.ts
├── instructions.md
├── tools/
└── skills/
```

Prefer the nested layout. It keeps the app root separate from the authored surface.

## Why didn't eve discover my file?

Run `eve info`. It lists the discovered surface and prints discovery diagnostics. From there, check that the file sits in the right authored slot (per the slot table above) and that the root-vs-subagent boundary is valid. eve also writes inspectable artifacts under `.eve/`. See the debugging artifacts in [instrumentation.ts](../guides/instrumentation) and the [CLI](./cli) reference.

## What to read next

- [`agent.ts`](../agent-config): the runtime config at the root
- [Tools](../tools): the most common authored slot
- [TypeScript API](./typescript-api): the define\* helpers and where they import from
