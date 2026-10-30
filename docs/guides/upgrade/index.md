---
title: "Upgrade to 1.0"
description: "Move an eve project from 0.83 or earlier to 1.0: the upgrade order, which guide pages apply to your project, rollout, verification, and troubleshooting."
navTitle: "Overview"
---

This guide moves a project from eve 0.83 or earlier to 1.0. Most of the work is mechanical: renamed APIs, moved imports, and stricter definitions that `eve build` and your typechecker point out. Two areas need more care, because mistakes there compile cleanly:

- **Code that reads session events.** The session stream moves from format v26 to v27, and most event names change. A hook, dashboard, or stream reader that still matches v26 names builds without errors and then matches nothing.
- **Session history your application stores.** Events saved before the upgrade are in v26 format. Re-read or convert them before you load them into a v27 client.

This page gives the order of work and links to a page for each part of a project. Read only the pages that apply to you. After the upgrade, the [stability policy](/docs/reference/typescript-api#stability-policy) tells you which APIs are stable and which are experimental.

## Upgrade in this order

1. **Rebuild your extensions.** eve refuses to load extensions built with 0.83 or earlier. Rebuild and republish the extensions you maintain, and upgrade third-party extensions to releases built for 1.0.
2. **Fix the agent build.** Upgrade `eve` in the agent server, then follow [Upgrade agent files](/docs/guides/upgrade/agent-files) until `eve build` and your typecheck pass.
3. **Update event consumers.** Move hooks, channel handlers, instrumentation, and stream readers to [v27 session events](/docs/guides/upgrade/session-events) before you deploy, so they don't silently stop firing.
4. **Deploy the server.** Keep the old deployments running, because existing sessions finish their current work there; see [Existing sessions](#existing-sessions). If you use remote agents, upgrade callers before the remote agents they call; see [Remote agents](#remote-agents).
5. **Upgrade clients and frontends** once the new server is live. New clients call routes, such as `/end`, that older servers don't serve; see [Upgrade clients and frontends](/docs/guides/upgrade/clients).
6. **Migrate saved history** if your application stores session events; see [Migrate saved history](/docs/guides/upgrade/saved-history).
7. **Check the result** with [Verify the upgrade](#verify-the-upgrade).

## Pick the pages you need

The pages are ordered from the changes that affect most projects to the ones that affect few.

| Page                                                                 | Read it if your project has…                                                                              |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [Upgrade agent files](/docs/guides/upgrade/agent-files)              | Any agent. Covers `agent.ts`, connections, tools, sandboxes, memory, imports, and Workflow tools.         |
| [Upgrade to v27 session events](/docs/guides/upgrade/session-events) | Hooks, channel `events` handlers, instrumentation, stream readers, or approvals, questions, and sign-ins. |
| [Upgrade clients and frontends](/docs/guides/upgrade/clients)        | `eve/client`, `useEveAgent`, `SessionStore`, or HTTP callers.                                             |
| [Upgrade channels](/docs/guides/upgrade/channels)                    | Slack, Teams, MCP, Chat SDK, or custom channels.                                                          |
| [Upgrade evals and CLI scripts](/docs/guides/upgrade/evals-and-cli)  | Evals, or scripts that call the `eve` CLI.                                                                |
| [Migrate saved history](/docs/guides/upgrade/saved-history)          | Session events saved in your own storage, or your own reducers and stream followers.                      |

## Existing sessions

Sessions that started on eve 0.69 through 0.83 move to the new deployment on their own. An idle session moves the next time it receives a message, or earlier when a channel prepares it for one. Until then, it stays on the deployment that started it, so keep that deployment running.

Two kinds of session stay on the old deployment:

- A session with a background task, including an idle resumable one, stays until the task finishes.
- A session that started on a release before 0.69 never moves.

When a session moves, eve compacts its earlier conversation. The model continues from a summary, and the stored transcript stays intact. Remembered tool approvals and usage limits start over, so people may be asked to approve a tool again.

On worlds without deployment routing, follow the [stranded-session recovery guidance](/docs/concepts/execution-model-and-durability#stranded-sessions).

## Verify the upgrade

1. Run your typecheck and `eve build`.
2. Create a conversation, send a message, end it, and start another.
3. Restore a saved session state and send to it.
4. Approve a tool call. Then cancel a turn while an approval is pending, and send a message while a sign-in is pending.
5. Run a recorded v27 stream through each event consumer, and check that hooks, dashboards, and UI show the expected output.
6. If your application stores history, test the paths it supports; see [Verify migrated history](/docs/guides/upgrade/saved-history#verify-migrated-history).
7. Call `client.info()` with an operator credential if your tooling uses it.
8. Test proactive Slack messages and durable workflow waits your project defines.

Review [run-data retention](/docs/agent-config#run-data-retention) before you rely on a finished transcript staying readable. Outside development, the default trace policy for private and unknown-audience sessions requests deletion when the session ends; whether data is deleted depends on the backend.

## Troubleshooting

| What you see                                                                    | What to do                                                                                                                          |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `Extension "<name>" uses an old epoch-based distribution manifest`              | Rebuild the extension with the new release, or install a compatible extension release.                                              |
| `Export defineAgent({...}) from "<path>".`                                      | [Export `defineAgent`](/docs/guides/upgrade/agent-files#export-defineagent-from-every-agentts) from that file.                      |
| `Rename "compaction.thresholdPercent" to "compaction.threshold"`                | [Rename the field](/docs/guides/upgrade/agent-files#rename-compactionthresholdpercent) and keep its value.                          |
| ``Import from `eve/workflow` (or `eve/workflow/api`) instead of "workflow"``    | [Update Workflow imports](/docs/guides/upgrade/agent-files#workflow-imports).                                                       |
| Sandbox commands fail with `pnpm: command not found` or a refused `pip install` | [Install them in `prepare`](/docs/guides/upgrade/agent-files#choose-one-sandbox-layout-and-install-your-tools).                     |
| Hooks, dashboards, or UI show nothing after the upgrade, with no errors         | A consumer still matches v26 event names; see [Find every consumer](/docs/guides/upgrade/session-events#find-every-consumer).       |
| `end()` or `POST /eve/v1/session/:sessionId/end` fails against an older server  | Deploy the upgraded server before the upgraded client.                                                                              |
| `400` naming unknown fields from the eve channel                                | Remove or correct the fields, or upgrade the server; see [Check request shapes](/docs/guides/upgrade/clients#check-request-shapes). |
| `InvalidSessionHistoryError`                                                    | Map `history` entries to `{ id, role, text }`.                                                                                      |
| `403` with code `info_forbidden`                                                | Call `client.info()` with an [operator credential](/docs/guides/upgrade/clients#read-agent-info-with-an-operator-credential).       |
| `REMOTE_AGENT_PROTOCOL_MISMATCH`                                                | Upgrade both deployments; see [Remote agents](#remote-agents).                                                                      |

## Remote agents

Remote agent calls use protocol 3. While you upgrade deployments one at a time, callers and remote agents can run different protocol versions:

- A protocol-3 caller relays approvals, questions, and sign-ins from a protocol-2 remote agent.
- A protocol-3 remote agent can't relay them to a protocol-2 caller. Upgrade callers before the remote agents they call, or upgrade both together.
- Callers and remote agents on different protocols can still exchange results.
- Calls to or from eve 0.66 through 0.68 fail at the start with `REMOTE_AGENT_PROTOCOL_MISMATCH`. Upgrade both deployments.

See [Upgrading callers and remote agents](/docs/guides/remote-agents#upgrading-callers-and-remote-agents).

If the caller is protected by Vercel Deployment Protection and the remote agent is in another project, its callbacks need two settings. On the caller, configure Trusted Sources to admit the remote's project and environment. On the remote deployment, list the caller's origins in `EVE_CALLBACK_TRUSTED_ORIGINS`. Callback URLs don't carry the caller's deployment protection bypass secret. See [How remote dispatch and callbacks work](/docs/guides/remote-agents#how-remote-dispatch-and-callbacks-work).
