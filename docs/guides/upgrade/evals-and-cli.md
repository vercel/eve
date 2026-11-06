---
title: "Upgrade Evals and CLI Scripts"
description: "Rename eval helpers and eve CLI flags for eve 1.0."
navTitle: "Evals and CLI"
---

Read this page if your project has evals or scripts that call the `eve` CLI. Both changes are renames.

This page is part of [Upgrade to 1.0](/docs/guides/upgrade).

## Evals

Eval assertions match v27 events and read session state from `view`. Rename the eval helpers as follows.

| Before                                                           | After                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------- |
| `inputRequests`, `pendingInputRequests`, `requireInputRequest()` | `interactions`, `pendingInteractions`, `requireInteraction()` |
| `loadedSkill`                                                    | `calledSkill`                                                 |
| `calledSubagent`                                                 | `calledAgent`                                                 |
| `noFailedActions`                                                | `noFailedCalls`                                               |
| `parked()`                                                       | `awaitingInput()`                                             |
| `attachSession(id)`                                              | `t.target.attach(id)`                                         |
| Action matchers                                                  | `turn.waitForToolCall()`                                      |
| `remoteUrl` field and matcher                                    | Removed                                                       |

See [Evals](/docs/evals).

## CLI

| Before              | After                                 |
| ------------------- | ------------------------------------- |
| `eve remote invoke` | `eve remote connect --print <prompt>` |
| `--tools`           | `--verbose`                           |
| `--reasoning`       | `--verbose`                           |
| `--subagents`       | `--verbose`                           |
| `--connection-auth` | Removed; sign-ins always show         |

`eve remote connect --print <prompt>` sends one prompt, prints the final reply, and exits. For scripted multi-turn sessions and answers, use `eve/client`.

The per-part display flags are replaced by one `--verbose` flag on `eve dev` and `eve remote connect`, which shows tool output, reasoning, and subagent activity in full. The old names aren't aliases. `--reasoning` on `eve init` and `eve set model` still sets the model's reasoning effort. See the [CLI reference](/docs/reference/cli).

```bash
eve dev --verbose
```
