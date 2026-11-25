import { historyFromMessages } from "#shared/history-from-messages.js";
import type { ToolContext } from "#tools/definition.js";
import type { SlackChannel, SlackOpenCodeChannelOptions } from "./slackChannel.js";

/** What {@link openCodeChannel} returns to the tool that calls it. */
export type SlackCodeChannelOpenResult =
  | { readonly sessionId: string; readonly status: "opened" }
  | { readonly reason: string; readonly status: "unavailable" };

/**
 * Forks the Slack conversation that called a tool into a new Slack code
 * channel. The code channel's session starts with the conversation the model
 * saw, then `message`. Slack links the channel in the conversation, and people
 * continue the work there.
 *
 * Call it from your own tool, passing your Slack channel, which needs
 * `codeChannels: true`:
 *
 * ```ts
 * async execute({ message, name }, ctx) {
 *   return await openCodeChannel(ctx, slack, message, { name });
 * }
 * ```
 *
 * Returns `unavailable` when the conversation isn't a Slack message or is
 * already a code channel. When Slack refuses, it throws with Slack's error. A
 * retried call reaches the same code channel and session once.
 */
export async function openCodeChannel(
  ctx: Pick<ToolContext, "callId" | "channel" | "messages" | "session" | "to">,
  slack: SlackChannel,
  message: string,
  options: SlackOpenCodeChannelOptions = {},
): Promise<SlackCodeChannelOpenResult> {
  const { channelId, codeChannel, installationTeamId, threadTs, triggeringMessageTs } =
    ctx.channel.metadata ?? {};
  if (codeChannel === true) return unavailable("This conversation is already a code channel.");
  if (typeof channelId !== "string" || typeof threadTs !== "string") {
    return unavailable("This conversation is not a Slack message.");
  }

  const delivery = await ctx
    .to(slack, {
      channelId,
      codeChannel: {
        ...(options.name !== undefined && { name: options.name }),
        originThreadTs: threadTs,
        originTs: typeof triggeringMessageTs === "string" ? triggeringMessageTs : threadTs,
      },
      ...(typeof installationTeamId === "string" && { installationTeamId }),
    })
    .send(message, {
      auth: ctx.session.auth.current,
      history: historyFromMessages(ctx.messages),
      idempotencyKey: `${ctx.session.id}:${ctx.callId}`,
    });
  return { sessionId: delivery.sessionId, status: "opened" };
}

function unavailable(reason: string): SlackCodeChannelOpenResult {
  return { reason, status: "unavailable" };
}
