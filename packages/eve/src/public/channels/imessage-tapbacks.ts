import type { SessionAuthContext } from "#channel/types.js";
import { getChannelInstrumentationKind } from "#channel/compiled-channel.js";
import { loadContext } from "#context/container.js";
import type {
  Adapter,
  Author,
  Chat,
  Message,
  ReactionEvent,
  Thread,
} from "#compiled/chat/index.js";
import type {
  ChatSdkChannel,
  ChatSdkChannelBridge,
  ChatSdkChannelState,
} from "#public/channels/chat-sdk/index.js";
import { defineTool, type ToolDefinition } from "#public/tools/index.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

/** The six standard iMessage tapbacks. */
export const IMESSAGE_TAPBACKS = [
  "love",
  "like",
  "dislike",
  "laugh",
  "emphasize",
  "question",
] as const;

/** A standard iMessage tapback. */
export type IMessageTapbackType = (typeof IMESSAGE_TAPBACKS)[number];

/** A tapback someone added to or removed from a message in an iMessage conversation. */
export interface IMessageTapback {
  /** `true` when the tapback was added, `false` when it was removed. */
  readonly added: boolean;
  /** The person who sent the tapback. */
  readonly author: Author;
  /** The message the tapback is on, when the provider includes it. */
  readonly message?: Message;
  /** Id of the message the tapback is on. */
  readonly messageId: string;
  /** The provider's raw event. */
  readonly raw: unknown;
  /** A standard tapback, or the emoji itself for an emoji tapback. */
  readonly tapback: IMessageTapbackType | (string & {});
}

/** Result of an `onTapback` hook. Return `null` to ignore the tapback. */
export type IMessageTapbackResult = {
  readonly auth: SessionAuthContext | null;
  readonly context?: readonly string[];
  /** Overrides the workflow run title without changing the message sent to the model. */
  readonly title?: string;
} | null;

/** Input of the tool returned by `tapbackTool()`. */
export interface IMessageTapbackToolInput {
  readonly tapback: IMessageTapbackType;
}

/** Context passed to an `onTapback` hook. */
export interface IMessageTapbackContext {
  /** Low-level Chat SDK thread for iMessage-specific operations. */
  readonly thread: Thread<unknown>;
}

type TapbackHook = (
  ctx: IMessageTapbackContext,
  tapback: IMessageTapback,
) => IMessageTapbackResult | Promise<IMessageTapbackResult>;

const TAPBACK_BY_EMOJI_NAME: Readonly<Record<string, IMessageTapbackType>> = {
  exclamation: "emphasize",
  heart: "love",
  laugh: "laugh",
  question: "question",
  thumbs_down: "dislike",
  thumbs_up: "like",
};

// iMessage's own wording when it shows a tapback as text.
const ADDED_VERB: Readonly<Record<IMessageTapbackType, string>> = {
  dislike: "Disliked",
  emphasize: "Emphasized",
  laugh: "Laughed at",
  like: "Liked",
  love: "Loved",
  question: "Questioned",
};

const MAX_QUOTED_CHARS = 200;

/** Normalizes a Chat SDK reaction event from an iMessage adapter. */
export function toIMessageTapback(event: ReactionEvent): IMessageTapback {
  return {
    added: event.added,
    author: event.user,
    message: event.message,
    messageId: event.messageId,
    raw: event.raw,
    tapback: TAPBACK_BY_EMOJI_NAME[event.emoji.name] ?? event.rawEmoji,
  };
}

/** Model-visible text for a tapback, in the form iMessage uses for tapbacks shown as text. */
export function iMessageTapbackText(tapback: IMessageTapback): string {
  const text = tapback.message?.text.trim();
  const target = text
    ? `“${text.length > MAX_QUOTED_CHARS ? `${text.slice(0, MAX_QUOTED_CHARS - 1)}…` : text}”`
    : "a message";
  const standard = isStandardTapback(tapback.tapback);
  if (!tapback.added) {
    return `Tapback: Removed ${standard ? `a ${tapback.tapback} tapback` : tapback.tapback} from ${target}`;
  }
  return standard
    ? `Tapback: ${ADDED_VERB[tapback.tapback as IMessageTapbackType]} ${target}`
    : `Tapback: Reacted ${tapback.tapback} to ${target}`;
}

/** Sends tapbacks people add or remove to eve when `onTapback` accepts them. */
export function dispatchIMessageTapbacks<TAdapters extends Record<string, Adapter>>(
  bridge: ChatSdkChannelBridge<TAdapters>,
  onTapback: TapbackHook,
): void {
  bridge.bot.onReaction(async (event: ReactionEvent) => {
    if (event.user.isMe) return;
    const tapback = toIMessageTapback(event);
    const result = await onTapback({ thread: event.thread }, tapback);
    if (result === null) return;
    await bridge.send(iMessageTapbackText(tapback), {
      auth: result.auth,
      context: [...(result.context ?? [])],
      thread: event.thread.toJSON(),
      title: result.title,
    });
  });
}

/**
 * Builds a tool that reacts to the latest message in the session's iMessage
 * conversation. It acts only in sessions that came through `channel`.
 */
export function iMessageTapbackTool(options: {
  readonly adapterName: string;
  readonly bot: Chat;
  readonly channel: ChatSdkChannel;
  readonly channelLabel: string;
}): ToolDefinition<IMessageTapbackToolInput, string> {
  const { adapterName, bot, channel, channelLabel } = options;
  return defineTool<IMessageTapbackToolInput, string>({
    availableInSubagents: false,
    description:
      "React to the latest message in this iMessage conversation with a tapback: love (heart), like (thumbs up), dislike (thumbs down), laugh (haha), emphasize (!!), or question (?). Use it to acknowledge a message, alone or alongside a reply.",
    inputSchema: {
      type: "object",
      properties: {
        tapback: {
          type: "string",
          enum: [...IMESSAGE_TAPBACKS],
          description: "The tapback to add.",
        },
      },
      required: ["tapback"],
      additionalProperties: false,
    },
    async execute({ tapback }) {
      if (!(IMESSAGE_TAPBACKS as readonly string[]).includes(tapback)) {
        throw new Error(
          `Unknown tapback "${tapback}". Use one of: ${IMESSAGE_TAPBACKS.join(", ")}.`,
        );
      }
      const adapter = loadContext().get(ChannelKey);
      const kind = getChannelInstrumentationKind(channel);
      if (adapter === undefined || kind === undefined || adapter.kind !== kind) {
        throw new Error(
          `Tapbacks work only in a conversation that came through the ${channelLabel} channel.`,
        );
      }
      const state = adapter.state as Partial<ChatSdkChannelState> | undefined;
      const threadId = state?.thread?.id;
      const messageId = state?.latestMessageId;
      if (!threadId || !messageId) {
        throw new Error("There is no message in this conversation to react to yet.");
      }
      // The step may run where the webhook didn't, so the adapter may not be initialized yet.
      await bot.initialize();
      await bot.getAdapter(adapterName).addReaction(threadId, messageId, tapback);
      return `Sent a ${tapback} tapback.`;
    },
  });
}

function isStandardTapback(value: string): value is IMessageTapbackType {
  return (IMESSAGE_TAPBACKS as readonly string[]).includes(value);
}
