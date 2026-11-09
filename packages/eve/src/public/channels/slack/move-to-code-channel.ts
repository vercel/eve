import { getChannelInstrumentationKind } from "#channel/compiled-channel.js";
import { sessionTables } from "#protocol/session-projection/session-view.js";
import type { ChannelEventContext, ChannelEventOf } from "#public/definitions/channel.js";
import type { ToolContext } from "#tools/definition.js";
import {
  slackCodeChannelContinuationToken,
  slackContinuationToken,
  type SlackHandle,
} from "./api.js";
import { createSlackCodeChannel, setSlackCodeChannelStatus } from "./code-channel.js";
import type { SlackChannel, SlackEventContext } from "./slackChannel.js";
import { clearStatus } from "./thread-status.js";

/** Where a moved session's code channel rides in the move tool's output. */
const MOVED_KEY = "eveSlackMovedToCodeChannel";

/** What {@link moveToCodeChannel} returns to the tool that calls it. */
export type SlackCodeChannelMoveResult =
  | {
      readonly status: "moved";
      /** The new code channel, which the rest of the turn already posts in. */
      readonly channelId: string;
      readonly [MOVED_KEY]: { readonly channelId: string; readonly isPrivate: boolean };
    }
  | { readonly reason: string; readonly status: "unavailable" };

/** How `moveToCodeChannel()` reaches Slack for the channel that named a move tool. */
interface SlackCodeChannelMove {
  readonly moveTool: string;
  readonly request: (workspace: {
    readonly installationTeamId: string | undefined;
    readonly teamId: string | undefined;
  }) => SlackHandle["request"];
}

// Enumerable, so `{ ...channel, routes }` wrappers keep it, as they keep build metadata.
const SLACK_CODE_CHANNEL_MOVE = Symbol.for("eve.slack.codeChannelMove");

/** @internal Lets `moveToCodeChannel()` open code channels with the Slack channel's credentials. */
export function setSlackCodeChannelMove(channel: object, move: SlackCodeChannelMove): void {
  Object.defineProperty(channel, SLACK_CODE_CHANNEL_MOVE, {
    configurable: true,
    enumerable: true,
    value: move,
  });
}

/**
 * Moves the Slack thread session that called a tool into a new Slack code
 * channel. Unlike {@link openCodeChannel}, which forks a new session into the
 * channel, the calling session itself moves, keeping its sandbox and full
 * history, and the thread gets a fresh session on its next message.
 *
 * Call it from the tool your Slack channel names in
 * `codeChannels: { moveTool }`. It opens the code channel from the triggering
 * message; once the call settles, the Slack channel moves the session there,
 * so the rest of the turn posts in the code channel:
 *
 * ```ts
 * async execute({ name }, ctx) {
 *   return await moveToCodeChannel(ctx, slack, { name });
 * }
 * ```
 *
 * Returns `unavailable` when the conversation isn't a Slack thread, is
 * already a code channel, or the calling tool isn't the channel's
 * `moveTool`. When Slack refuses, it throws Slack's error, and the session
 * stays in the thread.
 */
export async function moveToCodeChannel(
  ctx: Pick<ToolContext, "channel" | "session" | "toolName">,
  slack: SlackChannel,
  options: { readonly name?: string } = {},
): Promise<SlackCodeChannelMoveResult> {
  if (ctx.channel.kind !== getChannelInstrumentationKind(slack)) {
    return unavailable("This conversation is not on this Slack channel.");
  }
  const move = Reflect.get(slack, SLACK_CODE_CHANNEL_MOVE) as SlackCodeChannelMove | undefined;
  if (move?.moveTool !== ctx.toolName) {
    return unavailable(
      `Set \`codeChannels: { moveTool: "${ctx.toolName}" }\` on slackChannel() to move sessions with this tool.`,
    );
  }
  const metadata = (ctx.channel.metadata ?? {}) as Readonly<Record<string, unknown>>;
  const { channelId, threadTs } = metadata;
  if (metadata.codeChannel === true) {
    return unavailable("This conversation is already a code channel.");
  }
  if (typeof channelId !== "string" || typeof threadTs !== "string" || threadTs === "") {
    return unavailable("This conversation is not a Slack thread.");
  }
  const opened = await createSlackCodeChannel({
    name: options.name ?? "",
    originChannelId: channelId,
    originTs: stringOr(metadata.triggeringMessageTs, threadTs),
    requester: ctx.session.auth.current?.principalId ?? "anonymous",
    request: move.request({
      installationTeamId: stringOr(metadata.installationTeamId, undefined),
      teamId: stringOr(metadata.teamId, undefined),
    }),
  });
  return { channelId: opened.channelId, status: "moved", [MOVED_KEY]: opened };
}

function unavailable(reason: string): SlackCodeChannelMoveResult {
  return { reason, status: "unavailable" };
}

function stringOr<T>(value: unknown, fallback: T): string | T {
  return typeof value === "string" && value !== "" ? value : fallback;
}

/**
 * The Slack channel's half of a move, run when the move tool's call settles:
 * points the session at the code channel the tool opened, rebinds its Slack
 * state, and releases the thread's address so the thread's next message
 * starts a fresh session there.
 */
export async function moveSessionOnCallSettled(
  event: ChannelEventOf<"call.settled">,
  ctx: ChannelEventContext<SlackEventContext>,
  moveTool: string,
): Promise<void> {
  if (event.data.outcome !== "completed") return;
  // Only the named move tool moves a session; no other tool's output can, however it's shaped.
  const capability = sessionTables(ctx.view).calls[event.data.callId]?.capability;
  if (capability?.kind !== "tool" || capability.name !== moveTool) return;
  const moved = readMoved(event.data.output);
  if (moved === undefined) return;
  const { channel } = ctx;
  const { state } = channel;
  const { channelId, threadTs } = state;
  if (state.codeChannel === true || !channelId || !threadTs || !channel.continuation) return;

  // The thread's status and task card belong to the thread, which this session leaves.
  await clearStatus(channel);
  channel.continuation.alias(slackCodeChannelContinuationToken(moved.channelId));
  channel.continuation.release(slackContinuationToken({ channelId, threadTs }));
  state.audience = moved.isPrivate ? "private" : "public";
  state.channelId = moved.channelId;
  state.codeChannel = true;
  state.threadTs = null;
  state.replyThreadTs = null;
  state.pendingReplyThreadTs = null;
  state.taskCards = {};
  await setSlackCodeChannelStatus(channel.slack.request, moved.channelId, "processing");
}

function readMoved(
  output: unknown,
): { readonly channelId: string; readonly isPrivate: boolean } | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  const moved = (output as Record<string, unknown>)[MOVED_KEY] as
    | { readonly channelId?: unknown; readonly isPrivate?: unknown }
    | undefined;
  if (typeof moved?.channelId !== "string" || moved.channelId === "") return undefined;
  return { channelId: moved.channelId, isPrivate: moved.isPrivate === true };
}
