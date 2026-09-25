---
title: "Agent Files"
description: "Look up agent directory slots, path-derived names, subagent files, and filesystem discovery rules."
---

eve builds an agent from files under its agent directory. Each supported path determines how eve loads the file. For recommended project layouts and when to split agents, read [Project Structure](/docs/concepts/project-structure).

## Agent directory layout

In a single-agent project, the agent directory is `agent/`. In an eve agent workspace, each member has an `agents/<name>/agent/` directory. A minimal root agent needs an instructions source; `agent.ts` is optional when the default configuration is sufficient.

```text
agent/
├── agent.ts
├── instructions.md
├── instrumentation/
├── channels/
├── connections/
├── extensions/
├── hooks/
├── skills/
├── lib/
├── memory/
├── sandbox/
├── tools/
├── schedules/
└── subagents/
```

Add only the files you need. Framework defaults use the same slots, so a file at the same path replaces the default when eve compiles the agent. Evals live beside `agent/`, not inside it.

## Naming from paths

eve derives capability names from file paths:

| Path                                  | Resolves to           |
| ------------------------------------- | --------------------- |
| `agent/tools/get_weather.ts`          | tool `get_weather`    |
| `agent/connections/linear.ts`         | connection `linear`   |
| `agent/skills/summarize.md`           | skill `summarize`     |
| `agent/subagents/researcher/agent.ts` | subagent `researcher` |

A standalone root agent uses its package name (without an npm scope), or its app directory name when no name is set. An eve workspace member uses its directory name under `agents/`. A local subagent uses its directory name under `subagents/`.

## Agent files and directories

Paths below are relative to the agent directory. Root agents can use every path; subagents can use paths marked **Yes**.

| Path                                                    | Purpose                                   | Available to subagents | Notes                                                                                                                                   |
| ------------------------------------------------------- | ----------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `agent.ts`                                              | Runtime config                            | Yes                    | Model, model options, compaction, build, and experimental settings. See [Agents](/docs/agent-config).                                   |
| `instructions.md` / `instructions.ts` / `instructions/` | Base system prompt                        | Yes                    | A flat file or directory of `.md` and `.ts` files. Required on the root, optional on subagents. See [Instructions](/docs/instructions). |
| `instrumentation/`                                      | Telemetry providers and destinations      | No                     | One path-named provider per file. See [Instrumentation](/docs/observability/instrumentation).                                           |
| `channels/`                                             | HTTP and messaging entry points           | No                     | See [Channels](/docs/channels/overview).                                                                                                |
| `connections/`                                          | External MCP and OpenAPI services         | Yes                    | Static files define path-named connections; dynamic sources can resolve caller-specific connections.                                    |
| `extensions/`                                           | Mounted reusable capabilities             | Yes                    | File or directory mounts. See [Extensions](/docs/extensions).                                                                           |
| `hooks/`                                                | Lifecycle and stream-event subscribers    | Yes                    | Module-backed only; recursive directories are supported.                                                                                |
| `skills/`                                               | On-demand procedures and capability packs | Yes                    | Flat Markdown, module-backed skills, or packaged skills.                                                                                |
| `lib/`                                                  | Shared authored helper code               | Yes                    | Import-only; not copied into the sandbox.                                                                                               |
| `memory.ts` or `memory/<name>.ts`                       | Cross-session memory                      | Yes                    | Provider-backed slots. See [Memory](/docs/memory).                                                                                      |
| `sandbox.ts` or `sandbox/sandbox.ts`                    | The agent's sandbox                       | Yes                    | The framework default applies when neither is authored.                                                                                 |
| `sandbox/workspace/**`                                  | Files seeded into the sandbox             | Yes                    | Mirrored into `/workspace/` when a session starts.                                                                                      |
| `tools/`                                                | Typed executable integrations             | Yes                    | Module-backed only.                                                                                                                     |
| `schedules/`                                            | Recurring jobs                            | No                     | `defineSchedule` modules or Markdown prompts with `cron` frontmatter; recursive nesting is supported.                                   |
| `subagents/`                                            | Specialist child agents                   | Yes                    | Local directories or remote-agent definitions; nested subagents are supported.                                                          |

## Colocated tests

eve ignores JavaScript and TypeScript modules named `*.test.*` or `*.spec.*`,
along with `__tests__/` directories, during automatic discovery and when choosing
extension runtime entries.

```text
agent/tools/
├── get_weather.ts          # registered as get_weather
├── get_weather.test.ts     # excluded from discovery
└── __tests__/              # excluded from discovery
    └── fixtures.json
```

Explicit imports, sandbox workspace files, and packaged skill resources are unaffected.

## Files available in the sandbox

Agent source files are not automatically available to shell commands. Put files to copy into the sandbox's `/workspace/` under `agent/sandbox/workspace/`. Skill runtime files are seeded separately under `$HOME/.agents/skills/`, with `/workspace/skills/` as a fallback. See [Sandboxes](/docs/sandbox) and [Skills](/docs/skills).

## Local subagents

A local declared subagent lives at `agent/subagents/<name>/`:

```text
agent/subagents/researcher/
├── agent.ts                # required; must include description
├── instructions.md         # optional
├── tools/
└── subagents/
```

It uses the same `defineAgent` helper as the root and supports the slots marked **Yes** above. Channels, schedules, and instrumentation are root-only. A declared subagent does not inherit its parent's authored slots; see [Subagents](/docs/subagents#the-isolation-boundary) for defaults and isolation behavior.

## Flat layout

eve also supports agent files directly in the app root, without an `agent/` directory:

```text
my-agent/
├── package.json
├── agent.ts
├── instructions.md
├── tools/
└── skills/
```

Workspace members can also use flat agent files directly under `agents/<name>/`. Prefer the nested layouts in [Project Structure](/docs/concepts/project-structure) to keep application files separate from agent definitions.

## Debug file discovery

Run `eve info` from the agent's app directory, or `eve info --agent <name>` from an eve workspace root. It lists the discovered files and diagnostics. eve also writes inspectable artifacts under `.eve/`; see the [CLI reference](/docs/reference/cli#eve-info).

Workspace discovery includes only direct `agents/<name>/` children with agent files and no `package.json` of their own. A root `agent/` directory takes precedence over `agents/` and makes the project single-agent. See [Add a second root agent](/docs/concepts/project-structure#add-a-second-root-agent) to convert that layout.
