import { createHash } from "node:crypto";

import {
  BOARD_TEXT_LIMIT,
  BOARD_UPLOAD_LIMIT,
  createBoardClient,
  resolveBoardSettings,
  type BoardChannelSettings,
  type BoardClient,
  type BoardMessage,
  type BoardThread,
  type BoardWrittenMessage,
} from "eve/internal/board";
import type { SandboxSession } from "eve/sandbox";
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

const attach = z
  .array(z.string().min(1))
  .max(10)
  .optional()
  .describe(
    "Files in the sandbox to attach, up to 4 MB each: absolute paths, or paths relative to the workspace root.",
  );

const text = z
  .string()
  .max(BOARD_TEXT_LIMIT)
  .optional()
  .describe("Markdown. May be left out when attaching files.");

// The board stores what an upload says it is, and shows images, video, and text inline.
const TYPES: Readonly<Record<string, string>> = {
  avif: "image/avif",
  csv: "text/csv",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  log: "text/plain",
  md: "text/markdown",
  mp4: "video/mp4",
  pdf: "application/pdf",
  png: "image/png",
  txt: "text/plain",
  webm: "video/webm",
  webp: "image/webp",
};

/** Reads every file from the sandbox before uploading any, so a bad path uploads nothing. */
async function uploadFiles(
  board: BoardClient,
  paths: readonly string[] | undefined,
  getSandbox: () => Promise<SandboxSession>,
): Promise<string[] | undefined> {
  if (paths === undefined || paths.length === 0) return undefined;
  const sandbox = await getSandbox();
  const files = [];
  for (const path of paths) {
    const data = await sandbox.readBinaryFile({ path });
    if (data === null) throw new Error(`There is no file at ${path} in the sandbox.`);
    if (data.byteLength > BOARD_UPLOAD_LIMIT) {
      throw new Error(`${path} is over 4 MB, the most a board attachment can be.`);
    }
    const name = path.split("/").pop() || "file";
    files.push({ data, name, type: TYPES[name.split(".").pop()?.toLowerCase() ?? ""] });
  }
  const ids = [];
  for (const file of files) ids.push((await board.upload(file)).id);
  return ids;
}

/** What a write returns: the message, and the handles that notified no one. */
function written(message: BoardWrittenMessage) {
  return {
    ...summarize(message),
    ...(message.unknownMentions !== undefined && {
      unknownMentions: message.unknownMentions,
      warning: `${message.unknownMentions.map((handle) => `@${handle}`).join(", ")} matched no one on the board, so it stayed plain text and notified no one.`,
    }),
  };
}

function summarizeThread(thread: BoardThread) {
  return { message: summarize(thread.message), replies: thread.replies.map(summarize) };
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

function requireContent(text: string | undefined, attach: readonly string[] | undefined) {
  if ((text === undefined || text.trim() === "") && (attach === undefined || attach.length === 0)) {
    throw new Error("Pass text, files to attach, or both.");
  }
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
      "Read the board. Pass `id` to read a whole thread by any message in it, `link` to read the thread a Slack or GitHub link points to, or filters to list threads, newest activity first. Read a discussion before joining it.",
    inputSchema: z.object({
      id: messageId.optional(),
      link: z
        .string()
        .url()
        .optional()
        .describe("A link to a message on a platform the board syncs, such as a Slack permalink."),
      channel: z.string().min(1).optional().describe("A channel path, or `prefix/` for a subtree."),
      label: z.array(z.string().min(1)).optional().describe("`key` or `key=value` filters."),
      by: z.string().min(1).optional().describe("An author's handle."),
      mentions: z.string().min(1).optional().describe("A mentioned handle."),
      text: z.string().min(1).optional().describe("Text the thread contains."),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    async execute({ id, link, ...query }, ctx) {
      const board = client(settings, ctx.session.id);
      if (id !== undefined) return summarizeThread(await board.thread(id));
      if (link !== undefined) return summarizeThread(await board.linked(link));
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
      text,
      attach,
      labels: z.record(z.string(), z.string()).optional(),
      noSync: z
        .boolean()
        .optional()
        .describe("Keep the thread on the board, out of synced platforms."),
    }),
    async execute({ channel, text, attach, ...post }, ctx) {
      requireContent(text, attach);
      const board = client(settings, ctx.session.id);
      const attachments = await uploadFiles(board, attach, ctx.getSandbox);
      return written(
        await board.post(channel, { ...post, attachments, id: postId(ctx), text: text ?? "" }),
      );
    },
  });
}

/** Replies in a thread. */
export function defineBoardReplyTool(settings: Settings) {
  return defineTool({
    description: `Reply in a board thread. When a board thread started this session, your final message is already posted there as your reply: use this tool for other threads, or to attach files there. ${SHARED}`,
    inputSchema: z.object({
      id: messageId,
      text,
      attach,
      noSync: z
        .boolean()
        .optional()
        .describe("Keep the reply on the board, out of synced platforms."),
    }),
    async execute({ id, text, attach, ...post }, ctx) {
      requireContent(text, attach);
      const board = client(settings, ctx.session.id);
      const attachments = await uploadFiles(board, attach, ctx.getSandbox);
      return written(
        await board.reply(id, { ...post, attachments, id: postId(ctx), text: text ?? "" }),
      );
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

/** Shows what the agent is doing in a thread. */
export function defineBoardTypingTool(settings: Settings) {
  return defineTool({
    description:
      "Show that you're working in a board thread, with a short status such as `Running the tests`. It shows in the thread's synced platform threads, such as in place of Typing… in Slack, and writes nothing to the board.",
    inputSchema: z.object({
      id: messageId,
      status: z.string().min(1).max(100).optional(),
    }),
    async execute({ id, status }, ctx) {
      await client(settings, ctx.session.id).typing(id, status);
      return { ok: true };
    },
  });
}
