/**
 * Typed Slack fixtures for unit tests, built against eve's public Slack types
 * so fixture drift after an eve upgrade fails typecheck instead of passing
 * silently through a cast.
 *
 * @packageDocumentation
 */
import type {
  SlackAuthor,
  SlackChannelState,
  SlackEventContext,
  SlackHandle,
  SlackInboundMessageContext,
  SlackMessage,
  SlackRendererEvents,
  SlackRenderNext,
  SlackThread,
} from "eve/channels/slack";
import { vi } from "vitest";

import { sessionContext } from "./session";

const unsupported = (name: string) => (): never => {
  throw new Error(`This test does not provide ${name}.`);
};

/**
 * Builds the author eve derives for a human Slack user.
 *
 * @param overrides - Author properties to replace, such as `isBot` or `isMe`.
 * @returns A human author with user ID U123 unless overridden.
 */
export const slackAuthor = (
  overrides: Partial<SlackAuthor> = {}
): SlackAuthor => ({
  fullName: undefined,
  isBot: false,
  isMe: false,
  userId: "U123",
  userName: undefined,
  ...overrides,
});

/**
 * Builds a complete inbound Slack message matching eve's public webhook contract.
 *
 * @param overrides - Message properties to replace for the scenario under test.
 * @returns A human-authored message with stable channel, workspace, and thread identifiers.
 */
export const slackMessage = (
  overrides: Partial<SlackMessage> = {}
): SlackMessage => {
  const text = overrides.text ?? "";
  return {
    attachments: [],
    author: slackAuthor(),
    channelId: "C123",
    markdown: text,
    raw: {},
    teamId: "T123",
    text,
    threadTs: "100.1",
    ts: "100.2",
    ...overrides,
  };
};

/**
 * Builds a Slack thread handle with observable delivery and subscription operations.
 *
 * @param overrides - Explicit thread methods or properties required by the scenario.
 * @returns A thread fixture whose supported delivery methods return stable receipts and whose DMs fail unless supplied.
 */
export const slackThread = (
  overrides: Partial<SlackThread> = {}
): SlackThread => ({
  listParticipants: vi.fn<SlackThread["listParticipants"]>(() =>
    Promise.resolve([])
  ),
  mentionUser: (userId) => `<@${userId}>`,
  post: vi.fn<SlackThread["post"]>(
    async () =>
      await {
        id: "posted-ts",
        raw: { ok: true },
      }
  ),
  postDirectMessage: vi.fn<SlackThread["postDirectMessage"]>(
    unsupported("DMs")
  ),
  postEphemeral: vi.fn<SlackThread["postEphemeral"]>(
    async () =>
      await {
        id: "ephemeral-ts",
        raw: { ok: true },
      }
  ),
  recentMessages: [],
  refresh: vi.fn<SlackThread["refresh"]>(() => Promise.resolve()),
  startTyping: vi.fn<SlackThread["startTyping"]>(() => Promise.resolve()),
  ...overrides,
});

/* The `ctx.slack` handle; `request` defaults to an `{ ok: true }` spy. */
const slackHandle = (overrides: Partial<SlackHandle> = {}): SlackHandle => ({
  channelId: "C123",
  request: vi.fn<SlackHandle["request"]>(async () => await { ok: true }),
  teamId: "T123",
  threadTs: "100.1",
  uploadFiles: unsupported("file uploads"),
  ...overrides,
});

interface InboundContextOptions {
  mentioned?: boolean;
  slack?: Partial<SlackHandle>;
  subscribed?: boolean;
  thread?: Partial<SlackThread>;
}

/**
 * Builds the context supplied to Slack inbound message hooks.
 *
 * @param options - Mention/subscription state and optional Slack API or thread overrides.
 * @returns Routing context whose session mutation methods fail when unexpectedly called.
 */
export const inboundContext = ({
  mentioned = false,
  slack,
  subscribed = false,
  thread,
}: InboundContextOptions = {}): SlackInboundMessageContext => ({
  cancel: unsupported("session cancellation"),
  clear: unsupported("session clearing"),
  compact: unsupported("session compaction"),
  isBotMentioned: vi.fn(() => mentioned),
  isDMOrPrivateChannel: vi.fn(() => Promise.resolve(false)),
  isSubscribed: vi.fn(async () => await subscribed),
  reset: unsupported("session reset"),
  resolveSession: unsupported("session resolution"),
  respond: unsupported("input responses"),
  send: unsupported("session sends"),
  slack: slackHandle(slack),
  thread: slackThread(thread),
});

interface EventContextOptions {
  slack?: Partial<SlackHandle>;
  state?: Partial<SlackChannelState>;
  thread?: Partial<SlackThread>;
}

/**
 * Builds the hydrated channel context supplied to Slack event renderers.
 *
 * @param options - Slack API, channel-state, and thread overrides for the renderer test.
 * @returns A channel fixture with stable workspace/thread coordinates and observable thread methods.
 */
export const slackEventContext = ({
  slack,
  state,
  thread,
}: EventContextOptions = {}): SlackEventContext => ({
  slack: slackHandle(slack),
  state: { channelId: "C123", teamId: "T123", threadTs: "100.1", ...state },
  thread: slackThread(thread),
});

type MessageCompleted = NonNullable<SlackRendererEvents["message.completed"]>;

type MessageCompletedEvent = Parameters<MessageCompleted>[0];

/**
 * Exercises a message-completed renderer while observing final reply delegation.
 *
 * @param handler - Renderer whose posting or suppression behavior is under test.
 * @returns The channel, completion driver, post spy, and next-renderer spy.
 * @remarks The harness observes whether the chain continues without duplicating eve's own rendering.
 */
export const messageCompletedHarness = (handler: MessageCompleted) => {
  const post = vi.fn<SlackThread["post"]>(
    async () =>
      await {
        id: "posted-ts",
        raw: { ok: true },
      }
  );
  const channel = slackEventContext({ thread: { post } });
  const next = vi.fn<SlackRenderNext<"message.completed">>(() =>
    Promise.resolve()
  );
  const complete = (overrides: Partial<MessageCompletedEvent> = {}) =>
    handler(
      {
        finishReason: "stop",
        message: "Here is the result.",
        sequence: 1,
        stepIndex: 2,
        turnId: "turn-1",
        ...overrides,
      },
      channel,
      sessionContext(),
      next
    );
  return { channel, complete, next, post };
};
