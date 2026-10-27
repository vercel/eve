# Channel-state audit

Compared eve 0.82.0 and 0.83.0–0.83.3 state declarations, writers, prompt retirement,
serialization (`ChannelKey`), and current readers. This is source and local
migration-test evidence, not a live platform test. No Slack, Discord, Teams,
Telegram, GitHub, Linear, Twilio, Linq, or Photon credentials were used.

`resolveChannelDefinition()` stores path-derived kinds (`channel:<name>`), not
protocol discriminants. Conversions therefore cover conventional channel names;
unknown names with retired formats refuse instead of inferring the protocol
from arbitrary app state. Pending-work checks also apply to renamed wrappers.

| Surface                            | Idle-state migration                                                                                                                                                                                                            | Refusal boundary                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| eve HTTP / route-only / MCP        | No saved adapter-state conversion. Actual HTTP-owner captures cover 0.82.0 and every 0.83 patch. MCP exposes HTTP routes without its own conversational state.                                                                  | Harness checkpoint and stream must be idle.                                                                               |
| Discord                            | Convert `directMessage: true` to `channelType: 1`; keep audience, routing, message anchor, application and interaction-token fields.                                                                                            | `hitlPrompts`, sign-in messages, malformed/conflicting DM classification. A renamed Discord with the old DM flag refuses. |
| Slack                              | Retire settled `taskCards`; retain thread/workspace routing, principal-to-user mapping, audience, status and undelivered-reply state.                                                                                           | Approval cards, sign-in messages, undelivered task results. A renamed channel with old task cards refuses.                |
| Teams                              | Remove the obsolete singular `pendingAuthActivityId` when empty. Keep bot/user accounts, conversation type, service URL, thread and tenant routing.                                                                             | Prompt cards or nonempty auth activity fields (singular or plural).                                                       |
| Telegram                           | Retire settled `hitlCallbacks` containing old `InputResponse` values. Keep `nextHitlCallbackId` so stale platform callback IDs cannot be reused; retain chat, forum topic and actor routing.                                    | Active prompts, ForceReply mappings, sign-in messages. A renamed channel with old callback values refuses.                |
| Chat SDK                           | Remove empty `streamStepIndex` at the conventional `chat-sdk` path; keep serialized thread/adapter, user mapping, edit support and undelivered-reply state. New `streamPartId` is optional and initialized by the new renderer. | Input cards, sign-in messages, unfinished streaming anchors/text/step index.                                              |
| Linq / Photon                      | Use Chat SDK state; apply the same empty streaming-index conversion at their conventional paths.                                                                                                                                | Same pending-work checks as Chat SDK.                                                                                     |
| GitHub                             | Preserve repository/installation, checkout, issue/PR/review-thread and actor routing. New `pendingSignIns` is optional.                                                                                                         | `shownPromptId` (shared prompt queue).                                                                                    |
| Linear                             | Preserve agent-session, issue/comment, organization and source-comment routing; the narration buffer remains the same optional string.                                                                                          | `shownPromptId` (shared prompt queue).                                                                                    |
| Twilio                             | Preserve sender/recipient and SMS/call SIDs. New `pendingSignIns` is optional.                                                                                                                                                  | `shownPromptId` (shared prompt queue).                                                                                    |
| Subagents / remote-caller sessions | Not migrated.                                                                                                                                                                                                                   | Parent/callback context or subagent adapter.                                                                              |
| Other authored channels            | Retain app-owned JSON unchanged unless it contains a known pending registry or an ambiguous retired format.                                                                                                                     | Custom schema compatibility remains the application's responsibility, as for ordinary handoffs.                           |

Discord added its optional DM flag in 0.83. A 0.82 checkpoint without that flag
keeps its existing audience and routing; the migration does not infer a private
channel type from a missing guild ID. Other 0.82→0.83 channel changes affected
verification and gateway handling, not the saved state that an idle owner needs.

The 0.83 patch series added durable Chat SDK stream text and shared
undelivered-reply state. These are optional in the current readers; routing and
privacy fields did not change within the series. The relevant transitions to
v27 are the Discord DM flag, Telegram response shape, Chat SDK streaming index,
Teams auth registry, and Slack task-card contents.
