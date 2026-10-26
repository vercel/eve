import type { SessionHistoryMessage } from "#shared/session-history.js";
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
  // The Slack channel's metadata names the conversation and the message that
  // triggered the turn, whatever auth the session runs as.
  const { channelId, codeChannel, installationTeamId, threadTs, triggeringMessageTs } =
    ctx.channel.metadata ?? {};
  // Slack doesn't open a code channel from inside one.
  if (codeChannel === true) return unavailable("This conversation is already a code channel.");
  if (typeof channelId !== "string" || typeof threadTs !== "string") {
    return unavailable("This conversation is not a Slack message.");
  }

  const delivery = await ctx
    .to(slack, {
      channelId,
      // Slack checks this session is the origin thread's before creating anything.
      codeChannel: {
        ...(options.name !== undefined && { name: options.name }),
        originThreadTs: threadTs,
        originTs: typeof triggeringMessageTs === "string" ? triggeringMessageTs : threadTs,
      },
      ...(typeof installationTeamId === "string" && { installationTeamId }),
    })
    .send(message, {
      auth: ctx.session.auth.current,
      history: textHistory(ctx.messages),
      idempotencyKey: ctx.callId,
    });
  return { sessionId: delivery.sessionId, status: "opened" };
}

function unavailable(reason: string): SlackCodeChannelOpenResult {
  return { reason, status: "unavailable" };
}

/** The text of the conversation's user and assistant messages; tool calls and files drop out. */
function textHistory(messages: ToolContext["messages"]): SessionHistoryMessage[] {
  return messages.flatMap((entry) => {
    if (entry.role !== "user" && entry.role !== "assistant") return [];
    const text =
      typeof entry.content === "string"
        ? entry.content
        : entry.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
    return text === "" ? [] : [{ role: entry.role, text }];
  });
}
