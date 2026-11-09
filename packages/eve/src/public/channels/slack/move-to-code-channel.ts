import { getChannelInstrumentationKind } from "#channel/compiled-channel.js";
import { sessionTables } from "#protocol/session-projection/session-view.js";
import type { ChannelEventContext, ChannelEventOf } from "#public/definitions/channel.js";
import type { ToolContext } from "#tools/definition.js";
import { createLogger, logError } from "#internal/logging.js";
import { slackCodeChannelContinuationToken, slackContinuationToken } from "./api.js";
import { createSlackCodeChannel, setSlackCodeChannelStatus } from "./code-channel.js";
import type { SlackChannel, SlackEventContext } from "./slackChannel.js";
import { clearStatus } from "./thread-status.js";

const log = createLogger("slack.move-to-code-channel");

/** Where a move request rides in the tool's output, for the Slack channel to act on. */
const MOVE_REQUEST_KEY = "eveSlackMoveToCodeChannel";

/** What {@link moveToCodeChannel} returns to the tool that calls it. */
export type SlackCodeChannelMoveResult =
  | {
      readonly status: "moving";
      readonly [MOVE_REQUEST_KEY]: { readonly name: string };
    }
  | { readonly reason: string; readonly status: "unavailable" };

/**
 * Moves the Slack thread session that called a tool into a new Slack code
 * channel. Unlike {@link openCodeChannel}, which forks a new session into the
 * channel, the calling session itself moves, keeping its sandbox and full
 * history, and the thread gets a fresh session on its next message.
 *
 * Return its result from your tool. Once the call settles, the Slack channel
 * opens the code channel from the triggering message and moves the session
 * there, so the rest of the turn already posts in the code channel:
 *
 * ```ts
 * execute({ name }, ctx) {
 *   return moveToCodeChannel(ctx, slack, { name });
 * }
 * ```
 *
 * Returns `unavailable` when the conversation isn't a Slack thread or is
 * already a code channel. Your Slack channel needs `codeChannels: true`.
 */
export function moveToCodeChannel(
  ctx: Pick<ToolContext, "channel">,
  slack: SlackChannel,
  options: { readonly name?: string } = {},
): SlackCodeChannelMoveResult {
  if (ctx.channel.kind !== getChannelInstrumentationKind(slack)) {
    return unavailable("This conversation is not on this Slack channel.");
  }
  const { channelId, codeChannel, threadTs } = (ctx.channel.metadata ?? {}) as {
    readonly channelId?: unknown;
    readonly codeChannel?: unknown;
    readonly threadTs?: unknown;
  };
  if (codeChannel === true) return unavailable("This conversation is already a code channel.");
  if (typeof channelId !== "string" || typeof threadTs !== "string") {
    return unavailable("This conversation is not a Slack thread.");
  }
  return { status: "moving", [MOVE_REQUEST_KEY]: { name: options.name ?? "" } };
}

function unavailable(reason: string): SlackCodeChannelMoveResult {
  return { reason, status: "unavailable" };
}

/**
 * The Slack channel's half of a move, run when a tool call settles: opens the
 * code channel, points the session at it, and releases the thread's address
 * so the thread's next message starts a fresh session there.
 */
export async function moveSessionOnCallSettled(
  event: ChannelEventOf<"call.settled">,
  ctx: ChannelEventContext<SlackEventContext>,
): Promise<void> {
  if (event.data.outcome !== "completed") return;
  // Only the agent's own tools move a session, never a subagent's or a skill's output.
  if (sessionTables(ctx.view).calls[event.data.callId]?.capability.kind !== "tool") return;
  const request = readMoveRequest(event.data.output);
  if (request === undefined) return;
  const { channel } = ctx;
  const { state } = channel;
  const { channelId, threadTs } = state;
  if (state.codeChannel === true || !channelId || !threadTs || !channel.continuation) return;

  let opened: { readonly channelId: string; readonly isPrivate: boolean };
  try {
    opened = await createSlackCodeChannel({
      name: request.name,
      originChannelId: channelId,
      originTs: state.triggeringMessageTs ?? threadTs,
      requester: ctx.session.auth.current?.principalId ?? "anonymous",
      request: channel.slack.request,
    });
  } catch (error) {
    // A transient Slack error retries the step; a permanent one leaves the session in the thread.
    if ((error as { readonly fatal?: unknown }).fatal !== true) throw error;
    logError(log, "Slack refused to open a code channel to move into", error, { channelId });
    await channel.thread.post(
      `I couldn't move this conversation to a code channel, so I'm continuing here. ${(error as Error).message}`,
    );
    return;
  }

  // The thread's status and task card belong to the thread, which this session leaves.
  await clearStatus(channel);
  channel.continuation.alias(slackCodeChannelContinuationToken(opened.channelId));
  channel.continuation.release(slackContinuationToken({ channelId, threadTs }));
  state.audience = opened.isPrivate ? "private" : "public";
  state.channelId = opened.channelId;
  state.codeChannel = true;
  state.threadTs = null;
  state.replyThreadTs = null;
  state.pendingReplyThreadTs = null;
  state.taskCards = {};
  await setSlackCodeChannelStatus(channel.slack.request, opened.channelId, "processing");
}

function readMoveRequest(output: unknown): { readonly name: string } | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  const request = (output as Record<string, unknown>)[MOVE_REQUEST_KEY];
  if (typeof request !== "object" || request === null) return undefined;
  const name = (request as { readonly name?: unknown }).name;
  return { name: typeof name === "string" ? name : "" };
}
