import { createHash } from "node:crypto";

import {
  BOARD_TEXT_LIMIT,
  createBoardClient,
  resolveBoardSettings,
  type BoardChannelSettings,
  type BoardClient,
  type BoardMessage,
} from "eve/internal/board";
import { defineTool } from "eve/tools";
import { z } from "zod";

type Settings = () => Pick<BoardChannelSettings, "url" | "profile">;

const SHARED =
  "Board channels are shared with the team, and a channel may sync to Slack, GitHub, or Linear, so everything posted there can reach people outside the board.";

const messageId = z.string().min(1).describe("Any message ID in the thread, as the board gave it.");

function client(settings: Settings, session: string): BoardClient {
  const { url, profile } = resolveBoardSettings(settings());
  return createBoardClient({ profile, session, url });
}

/**
 * The board dedupes a post's `id` per profile across the whole board, and every session posts as
 * the same profile, while a call ID is unique only within its session. Hashing both keeps the key
 * unique and under the board's 200-character limit, so a retried call lands once.
 */
function postId(ctx: { readonly callId: string; readonly session: { readonly id: string } }) {
  return createHash("sha256").update(`${ctx.session.id}:${ctx.callId}`).digest("hex");
}

/** What the model reads about a message: enough to follow and reply, without board bookkeeping. */
function summarize(message: BoardMessage) {
  return {
    attachments: message.attachments.map((attachment) => attachment.name),
    author: message.author?.handle ?? message.by.actor,
    channel: message.channel,
    createdAt: message.createdAt,
    id: message.id,
    labels: message.labels,
    re: message.re,
    text: message.deleted ? "(deleted)" : message.text,
  };
}

/** Lists the board's channels. */
export function defineBoardChannelsTool(settings: Settings) {
  return defineTool({
    description: "List the board's channels, with how many threads and messages each has.",
    inputSchema: z.object({}),
    async execute(_input, ctx) {
      return { channels: await client(settings, ctx.session.id).channels() };
    },
  });
}

/** Reads a thread, or a channel's threads. */
export function defineBoardReadTool(settings: Settings) {
  return defineTool({
    description:
      "Read the board. Pass `id` to read a whole thread by any message in it, or filters to list threads, newest activity first. Read a discussion before joining it.",
    inputSchema: z.object({
      id: messageId.optional(),
      channel: z.string().min(1).optional().describe("A channel path, or `prefix/` for a subtree."),
      label: z.array(z.string().min(1)).optional().describe("`key` or `key=value` filters."),
      by: z.string().min(1).optional().describe("An author's handle."),
      mentions: z.string().min(1).optional().describe("A mentioned handle."),
      text: z.string().min(1).optional().describe("Text the thread contains."),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    async execute({ id, ...query }, ctx) {
      const board = client(settings, ctx.session.id);
      if (id !== undefined) {
        const thread = await board.thread(id);
        return { message: summarize(thread.message), replies: thread.replies.map(summarize) };
      }
      const threads = await board.threads({ ...query, limit: query.limit ?? 20 });
      return {
        threads: threads.map((thread) => ({
          last: thread.last === null ? null : summarize(thread.last),
          message: summarize(thread.message),
          replies: thread.replies,
        })),
      };
    },
  });
}

/** Starts a thread in a channel. */
export function defineBoardPostTool(settings: Settings) {
  return defineTool({
    description: `Start a new board thread in a channel. Reply in an existing thread instead when one fits. ${SHARED}`,
    inputSchema: z.object({
      channel: z.string().min(1).describe("The channel path. The first post creates a channel."),
      text: z.string().min(1).max(BOARD_TEXT_LIMIT).describe("Markdown."),
      labels: z.record(z.string(), z.string()).optional(),
      noSync: z
        .boolean()
        .optional()
        .describe("Keep the thread on the board, out of synced platforms."),
    }),
    async execute({ channel, ...post }, ctx) {
      const message = await client(settings, ctx.session.id).post(channel, {
        ...post,
        id: postId(ctx),
      });
      return summarize(message);
    },
  });
}

/** Replies in a thread. */
export function defineBoardReplyTool(settings: Settings) {
  return defineTool({
    description: `Reply in a board thread. ${SHARED}`,
    inputSchema: z.object({
      id: messageId,
      text: z.string().min(1).max(BOARD_TEXT_LIMIT).describe("Markdown."),
      noSync: z
        .boolean()
        .optional()
        .describe("Keep the reply on the board, out of synced platforms."),
    }),
    async execute({ id, ...post }, ctx) {
      const message = await client(settings, ctx.session.id).reply(id, {
        ...post,
        id: postId(ctx),
      });
      return summarize(message);
    },
  });
}

/** Reacts to a message. */
export function defineBoardReactTool(settings: Settings) {
  return defineTool({
    description:
      "React to a board message with an emoji short name, such as `eyes` or `white_check_mark`.",
    inputSchema: z.object({
      id: z.string().min(1).describe("The message ID."),
      emoji: z.string().min(1),
      remove: z.boolean().optional(),
    }),
    async execute({ id, emoji, remove }, ctx) {
      await client(settings, ctx.session.id).react(id, emoji, { remove });
      return { ok: true };
    },
  });
}

/** Sets or unsets labels on a thread. */
export function defineBoardLabelTool(settings: Settings) {
  return defineTool({
    description:
      "Set or unset labels on a board message; labels on a thread's root apply to the whole thread. Use them to mark state, such as `status=done`.",
    inputSchema: z.object({
      id: z.string().min(1).describe("The message ID."),
      set: z.record(z.string(), z.string()).optional(),
      unset: z.array(z.string()).optional(),
    }),
    async execute({ id, set, unset }, ctx) {
      await client(settings, ctx.session.id).label(id, { set, unset });
      return { ok: true };
    },
  });
}
