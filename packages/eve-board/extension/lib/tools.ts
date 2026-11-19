import { createHash } from "node:crypto";

import type { SessionAuthContext } from "eve/context";
import type { SandboxSession } from "eve/sandbox";
import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  BOARD_TEXT_LIMIT,
  BOARD_UPLOAD_LIMIT,
  createBoardClient,
  resolveBoardTarget,
  type BoardClient,
  type BoardMessage,
  type BoardSettings,
  type BoardThread,
  type BoardWrittenMessage,
} from "./client.ts";
import {
  checkWatchScope,
  createWatch,
  DEFAULT_WATCH_CHANNEL,
  listWatches,
  removeWatch,
  watchIdOf,
  type BoardWatchAction,
} from "./watches.ts";

type Settings = () => BoardSettings;

interface ToolContext {
  readonly callId: string;
  readonly session: {
    readonly id: string;
    readonly auth?: { readonly current: SessionAuthContext | null };
  };
  readonly channel?: { readonly metadata?: unknown };
}

const SHARED =
  "Board channels are shared with the team, and a channel may sync to Slack, GitHub, or Linear, so everything posted there can reach people outside the board.";

const messageId = z.string().min(1).describe("Any message ID in the thread, as the board gave it.");

function client(settings: Settings): BoardClient {
  return createBoardClient(resolveBoardTarget(settings()));
}

function deploymentClient(settings: Settings): BoardClient {
  return createBoardClient(resolveBoardTarget({ ...settings(), can: undefined }));
}

function postId(ctx: ToolContext) {
  return createHash("sha256").update(`${ctx.session.id}:${ctx.callId}`).digest("hex");
}

function metadataOf(ctx: ToolContext): Readonly<Record<string, unknown>> {
  const metadata = ctx.channel?.metadata;
  return typeof metadata === "object" && metadata !== null
    ? (metadata as Record<string, unknown>)
    : {};
}

function currentThread(ctx: ToolContext): string | undefined {
  const thread = metadataOf(ctx).boardThread;
  return typeof thread === "string" && thread.length > 0 ? thread : undefined;
}

function threadOrCurrent(id: string | undefined, ctx: ToolContext): string {
  const thread = id ?? currentThread(ctx);
  if (thread === undefined) {
    throw new Error("Pass the thread's `id`: this session didn't start from a board thread.");
  }
  return thread;
}

function heldClaim(ctx: ToolContext): { readonly id: string; readonly until: string } {
  const task = metadataOf(ctx).boardTask as { id?: unknown; until?: unknown } | null | undefined;
  if (
    typeof task !== "object" ||
    task === null ||
    typeof task.id !== "string" ||
    typeof task.until !== "string"
  ) {
    throw new Error(
      "This session holds no board task: settle tools work only in a session that claimed one.",
    );
  }
  if (Date.parse(task.until) <= Date.now()) {
    throw new Error(
      `You no longer hold board task #${task.id}: its claim ran out. Stop working on it.`,
    );
  }
  return { id: task.id, until: task.until };
}

function settle(
  ctx: ToolContext,
  settled: "completed" | "failed" | "blocked",
  details: { readonly result?: string; readonly reason?: string; readonly kind?: string },
) {
  return { settled, task: heldClaim(ctx).id, ...details };
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
    ...(message.task !== undefined && {
      task: {
        blocked: message.task.blocked,
        holder: message.task.claim?.actor ?? null,
        result: message.task.result,
        state: message.task.state,
      },
    }),
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
    description: "List the board's channels you can read.",
    inputSchema: z.object({}),
    async execute() {
      return { channels: await client(settings).channels() };
    },
  });
}

/** Reads a thread, or a channel's threads. */
export function defineBoardReadTool(settings: Settings) {
  return defineTool({
    description:
      "Read the board. Pass `id` to read a whole thread by any message in it, `link` to read the thread a Slack or GitHub link points to, or filters to list threads, newest activity first. Read a discussion before joining it. A task's state and holder show on its root.",
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
    async execute({ id, link, ...query }) {
      const board = client(settings);
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
      const board = client(settings);
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
    description: `Reply in a board thread. When a board discussion started this session, your final message is already posted there as your reply: use this tool for other threads, to attach files, or for progress on a task you hold. ${SHARED}`,
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
      const board = client(settings);
      const attachments = await uploadFiles(board, attach, ctx.getSandbox);
      return written(
        await board.reply(id, { ...post, attachments, id: postId(ctx), text: text ?? "" }),
      );
    },
  });
}

/** Keeps a note in a thread, on the board only. */
export function defineBoardNoteTool(settings: Settings) {
  return defineTool({
    description:
      "Keep a working note in a board thread: a reply that stays on the board and never reaches synced Slack, GitHub, or Linear threads. Use it for detail the team can read on the board, such as what you tried. Defaults to this session's thread.",
    inputSchema: z.object({
      id: messageId.optional(),
      text: z.string().min(1).max(BOARD_TEXT_LIMIT),
    }),
    async execute({ id, text }, ctx) {
      return written(
        await client(settings).reply(threadOrCurrent(id, ctx), {
          id: postId(ctx),
          noSync: true,
          text,
        }),
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
    async execute({ id, emoji, remove }) {
      await client(settings).react(id, emoji, { remove });
      return { ok: true };
    },
  });
}

/** Sets or unsets labels on a thread. */
export function defineBoardLabelTool(settings: Settings) {
  return defineTool({
    description:
      "Set or unset labels on a board message; labels on a thread's root apply to the whole thread. Use them to mark state others filter on, such as `status=done`. Labels under `board.` are the board's own.",
    inputSchema: z.object({
      id: z.string().min(1).describe("The message ID."),
      set: z.record(z.string(), z.string()).optional(),
      unset: z.array(z.string()).optional(),
    }),
    async execute({ id, set, unset }) {
      await client(settings).label(id, { set, unset });
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
      status: z.string().min(1).max(50).optional(),
    }),
    async execute({ id, status }) {
      await client(settings).typing(id, status);
      return { ok: true };
    },
  });
}

/** Schedules a message that wakes the agent later. */
export function defineBoardScheduleTool(settings: Settings) {
  return defineTool({
    description:
      "Schedule a message in a board thread for later, as yourself: it wakes you there when it posts, so you can come back to something that takes time, such as a CI run. Write it for a reader who remembers nothing: what to check and what comes next. Defaults to this session's thread, and to staying off synced platforms. Pass `in` or `at` for once, or `every` with `times` or `until` for a repeat.",
    inputSchema: z.object({
      id: messageId.optional(),
      text: z.string().min(1).max(BOARD_TEXT_LIMIT),
      in: z.string().min(1).optional().describe("A duration from now, such as `5m` or `1d`."),
      at: z.string().datetime().optional().describe("An ISO 8601 time."),
      every: z.string().min(1).optional().describe("Repeat this often, at least `1m` apart."),
      times: z.number().int().min(1).max(100).optional(),
      until: z.string().datetime().optional(),
      sync: z
        .boolean()
        .optional()
        .describe("Also post it to the thread's synced platforms, such as Slack."),
    }),
    async execute({ id, sync, ...timing }, ctx) {
      const schedule = await client(settings).schedule(
        { re: threadOrCurrent(id, ctx) },
        { ...timing, noSync: sync !== true },
      );
      return { id: schedule.id, next: schedule.next, thread: schedule.re };
    },
  });
}

/** Cancels a scheduled message. */
export function defineBoardCancelScheduleTool(settings: Settings) {
  return defineTool({
    description:
      "Cancel a scheduled board message by its ID, such as once what it checks on has happened.",
    inputSchema: z.object({ id: z.string().min(1).describe("The schedule's ID.") }),
    async execute({ id }) {
      return await client(settings).cancelSchedule(id);
    },
  });
}

/** Creates a task on the board's queue. */
export function defineBoardCreateTaskTool(settings: Settings) {
  return defineTool({
    description: `Create a task on the board's queue: a thread whose root is the brief for whoever claims it, any agent or person. Write the brief for a stranger: what to do, what's out of scope, and how to tell it's done. ${SHARED}`,
    inputSchema: z.object({
      channel: z.string().min(1).describe("The channel the queue is in."),
      text: z.string().min(1).max(BOARD_TEXT_LIMIT).describe("The brief."),
      labels: z
        .record(z.string(), z.string())
        .optional()
        .describe("Labels that route it, such as `{ role: 'review' }`."),
      needs: z
        .array(z.string().min(1))
        .optional()
        .describe("Task IDs it waits for: it becomes ready when they complete."),
      noSync: z.boolean().optional(),
    }),
    async execute({ channel, ...task }, ctx) {
      const created = await client(settings).createTask(channel, { ...task, id: postId(ctx) });
      return summarize(created);
    },
  });
}

/** Completes the task this session holds. */
export function defineBoardCompleteTaskTool(_settings: Settings) {
  return defineTool({
    description:
      "Complete the board task you hold, with the result: what you did and the proof, such as a pull request link. Call it once the brief's check passes, as your last step.",
    inputSchema: z.object({ result: z.string().min(1).max(BOARD_TEXT_LIMIT).optional() }),
    async execute({ result }, ctx) {
      return settle(ctx, "completed", { result });
    },
  });
}

/** Fails the task this session holds. */
export function defineBoardFailTaskTool(_settings: Settings) {
  return defineTool({
    description:
      "Give up on the board task you hold, with why. Its owner can reopen it. Use it when the task can't be done as briefed.",
    inputSchema: z.object({ reason: z.string().min(1).max(BOARD_TEXT_LIMIT) }),
    async execute({ reason }, ctx) {
      return settle(ctx, "failed", { reason });
    },
  });
}

/** Holds the task this session holds for a person. */
export function defineBoardBlockTaskTool(_settings: Settings) {
  return defineTool({
    description:
      "Hold the board task you hold for a person, with the one question they must answer: ask it in the thread with your recommendation first. Blocking ends your claim; once its owner answers and unblocks it, whoever claims it next reads the whole thread.",
    inputSchema: z.object({
      reason: z.string().min(1).max(BOARD_TEXT_LIMIT).describe("The question, in one line."),
      kind: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe("What the hold is for, such as `needs_input` or `awaiting_approval`."),
    }),
    async execute({ reason, kind }, ctx) {
      return settle(ctx, "blocked", { kind, reason });
    },
  });
}

function assertConfigurer(settings: Settings, ctx: ToolContext): void {
  const caller = ctx.session.auth?.current ?? null;
  const allowed = settings().configurers;
  if (allowed !== undefined) {
    if (caller !== null && allowed.includes(caller.principalId)) return;
    throw new Error(
      "Only the people this agent's `configurers` names may change its board watches. Ask one of them.",
    );
  }
  if (caller?.authenticator === "board-watcher" && caller.attributes.actor_kind !== "person") {
    throw new Error(
      "Only a person on the team may change this agent's board watches, not a synced platform user or another agent.",
    );
  }
}

const queue = z
  .object({
    channel: z
      .string()
      .min(1)
      .describe("The channel, or a subtree such as `work/`, to claim ready tasks from."),
    label: z
      .record(z.string(), z.string())
      .optional()
      .describe("Labels a task must have, such as `{ role: 'review' }`."),
    from: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "Owners whose tasks to take, by principal ID. Without them, only this deployment's own tasks.",
      ),
  })
  .describe(
    "Claim a ready task from this queue when the watch matches, and work the claimed task's thread. Leave it out to reply in the matching thread.",
  );

/** Creates a watch: the board wakes the agent with these instructions when the tail matches. */
export function defineBoardWatchTool(settings: Settings) {
  return defineTool({
    description:
      "Watch the board: from now on, every event the tail matches wakes you in that board thread with these instructions, across conversations, cold starts, and redeploys. Use it when someone asks you to watch a channel and act on what's posted there. Returns the watch's ID.",
    inputSchema: z.object({
      tail: z
        .string()
        .min(1)
        .max(1000)
        .describe(
          "What to watch: what you'd type after `vb tail`, naming one channel, such as `incidents` or `work/ --label kind=bug`.",
        ),
      instructions: z
        .string()
        .min(1)
        .max(BOARD_TEXT_LIMIT)
        .describe(
          "What to do when it matches, written for a reader who remembers nothing of this conversation.",
        ),
      claim: queue.optional(),
    }),
    async execute({ tail, instructions, claim }, ctx) {
      assertConfigurer(settings, ctx);
      const config = settings();
      const watchChannel = config.watchChannel ?? DEFAULT_WATCH_CHANNEL;
      const action: BoardWatchAction =
        claim === undefined ? { type: "converse" } : { queue: claim, type: "claim" };
      checkWatchScope({ action, can: config.can, tail, watchChannel });
      const watch = await createWatch({
        action,
        client: deploymentClient(settings),
        id: watchIdOf(ctx.session.id, ctx.callId),
        instructions,
        tail: tail.trim(),
        watchChannel,
      });
      return { action: watch.action, id: watch.id, tail: watch.tail };
    },
  });
}

/** Lists the agent's watches. */
export function defineBoardWatchesTool(settings: Settings) {
  return defineTool({
    description:
      "List your board watches: each one's ID and what it matches, and with `details`, what it does.",
    inputSchema: z.object({
      details: z.boolean().optional().describe("Also read each watch's instructions and action."),
    }),
    async execute({ details }) {
      const config = settings();
      return {
        watches: await listWatches({
          client: deploymentClient(settings),
          details: details === true,
          watchChannel: config.watchChannel ?? DEFAULT_WATCH_CHANNEL,
        }),
      };
    },
  });
}

/** Removes a watch. */
export function defineBoardUnwatchTool(settings: Settings) {
  return defineTool({
    description:
      "Stop a board watch by its ID: it no longer wakes you, and your other watches keep running.",
    inputSchema: z.object({ id: z.string().min(1).max(100) }),
    async execute({ id }, ctx) {
      assertConfigurer(settings, ctx);
      const config = settings();
      return await removeWatch({
        client: deploymentClient(settings),
        id,
        watchChannel: config.watchChannel ?? DEFAULT_WATCH_CHANNEL,
      });
    },
  });
}
