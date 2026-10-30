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

See [Evals](/docs/evals/overview).

## CLI

| Before              | After                                 |
| ------------------- | ------------------------------------- |
| `eve remote invoke` | `eve remote connect --print <prompt>` |
| `--tools`           | `--show-tools`                        |
| `--reasoning`       | `--show-reasoning`                    |
| `--subagents`       | `--show-subagents`                    |
| `--connection-auth` | `--show-connection-auth`              |

`eve remote connect --print <prompt>` sends one prompt, prints the final reply, and exits. For scripted multi-turn sessions and answers, use `eve/client`.

The display flags apply to `eve dev` and `eve remote connect`. They take the same values as before, and the old names aren't aliases. `--reasoning` on `eve init` and `eve set model` still sets the model's reasoning effort. See the [CLI reference](/docs/reference/cli).

```bash
eve dev --show-reasoning full --show-tools auto-collapsed
```
