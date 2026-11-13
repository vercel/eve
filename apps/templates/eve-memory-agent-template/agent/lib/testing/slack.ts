/**
 * Typed Slack fixtures for unit tests, built against eve's public Slack types
 * so fixture drift after an eve upgrade fails typecheck instead of passing
 * silently through a cast.
 *
 * @packageDocumentation
 */
import type {
  SlackAuthor,
  SlackHandle,
  SlackInboundMessageContext,
  SlackMessage,
  SlackThread,
} from "eve/channels/slack";
import { vi } from "vitest";

const unsupported = (name: string) => (): never => {
  throw new Error(`This test does not provide ${name}.`);
};

/* The author eve derives for a human Slack user. */
const slackAuthor = (overrides: Partial<SlackAuthor> = {}): SlackAuthor => ({
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
  slack?: Partial<SlackHandle>;
  thread?: Partial<SlackThread>;
}

/**
 * Builds the context supplied to Slack inbound message hooks.
 *
 * @param options - Optional Slack API or thread overrides.
 * @returns Routing context whose session mutation methods fail when unexpectedly called.
 */
export const inboundContext = ({
  slack,
  thread,
}: InboundContextOptions = {}): SlackInboundMessageContext => ({
  cancel: unsupported("session cancellation"),
  clear: unsupported("session clearing"),
  compact: unsupported("session compaction"),
  isBotMentioned: vi.fn(() => false),
  isDMOrPrivateChannel: vi.fn(() => Promise.resolve(false)),
  isSubscribed: vi.fn(() => Promise.resolve(false)),
  reset: unsupported("session reset"),
  resolveSession: unsupported("session resolution"),
  respond: unsupported("input responses"),
  send: unsupported("session sends"),
  slack: slackHandle(slack),
  thread: slackThread(thread),
});
