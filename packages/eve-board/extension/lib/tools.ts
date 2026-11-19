import type { SandboxSession } from "eve/sandbox";
import { defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";

import type { BoardChannelMetadata } from "./board-channel.ts";
import {
  BOARD_HOLD_KIND_PATTERN,
  BOARD_TASK_NOTE_LIMIT,
  BOARD_TEXT_LIMIT,
  BOARD_NAME_PATTERN,
  BOARD_UPLOAD_LIMIT,
  boardPostId,
  type BoardClient,
  type BoardMessage,
  type BoardSettings,
  type BoardThread,
  type BoardWrittenMessage,
} from "./client.ts";
import {
  boardClients,
  checkWatchScope,
  createWatch,
  listWatches,
  removeWatch,
  tailOf,
  watchIdOf,
  type BoardWatchAction,
} from "./watches.ts";
import { authorOf } from "./inbound.ts";

type Settings = () => BoardSettings;

const SHARED =
  "Board channels are shared with the team, and a channel may sync to Slack, GitHub, or Linear, so everything posted there can reach people outside the board.";

const messageId = z.string().min(1).describe("Any message ID in the thread, as the board gave it.");

function client(settings: Settings): BoardClient {
  return boardClients(settings()).model;
}

function postId(ctx: ToolContext) {
  return boardPostId(`${ctx.session.id}:${ctx.callId}`);
}

function boardMetadata(ctx: Pick<ToolContext, "channel">): Partial<BoardChannelMetadata> {
  return ctx.channel.metadata as Partial<BoardChannelMetadata>;
}

function currentThread(ctx: ToolContext): string | undefined {
  return boardMetadata(ctx).boardThread || undefined;
}

function threadOrCurrent(id: string | undefined, ctx: ToolContext): string {
  const thread = id ?? currentThread(ctx);
  if (thread === undefined) {
    throw new Error("Pass the thread's `id`: this session didn't start from a board thread.");
  }
  return thread;
}

export function holdsTask(ctx: Pick<ToolContext, "channel">): boolean {
  return boardMetadata(ctx).boardTask != null;
}

function heldClaim(ctx: ToolContext): string {
  const task = boardMetadata(ctx).boardTask;
  if (task == null) {
    throw new Error(
      "This session holds no board task: settle tools work only in a session that claimed one.",
    );
  }
  if (Date.parse(task.until) <= Date.now()) {
    throw new Error(
      `You no longer hold board task #${task.id}: its claim ran out. Stop working on it.`,
    );
  }
  return task.id;
}

function settle(
  ctx: ToolContext,
  settled: "completed" | "failed" | "blocked",
  details: { readonly result?: string; readonly reason?: string; readonly kind?: string },
) {
  return { settled, task: heldClaim(ctx), ...details };
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
    files.push({ data, name });
  }
  const ids = [];
  for (const file of files) ids.push((await board.upload(file)).id);
  return ids;
}

function written(message: BoardWrittenMessage) {
  return {
    ...summarize(message),
    ...(message.unknownMentions !== undefined && {
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
    author: authorOf(message),
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
    deferred: true,
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
      "Read the board. Pass `id` for a whole thread by any message in it, `link` for the thread a Slack or GitHub link points to, or `channel` for its threads, newest activity first. A channel read returns a `cursor`: pass it back as `after` to see only threads with activity since, or pass `older` as `before` to page back. The board has no search, so read the channel something would be in. Read a discussion before joining it. A task's state and holder show on its root.",
    inputSchema: z.object({
      id: messageId.optional(),
      link: z
        .string()
        .url()
        .optional()
        .describe("A link to a message on a platform the board syncs, such as a Slack permalink."),
      channel: z.string().min(1).optional().describe("A channel path, or `prefix/` for a subtree."),
      label: z.array(z.string().min(1)).optional().describe("`key` or `key=value` filters."),
      after: z
        .string()
        .min(1)
        .optional()
        .describe(
          "With `channel`, a `cursor` an earlier read returned; with `id`, a message ID, to read only the replies after it.",
        ),
      before: z
        .string()
        .min(1)
        .optional()
        .describe("With `channel`, the `older` an earlier read returned."),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async execute({ id, link, after, ...query }) {
      const board = client(settings);
      if (id !== undefined) return summarizeThread(await board.thread(id, { after }));
      if (link !== undefined) return summarizeThread(await board.linked(link));
      if (query.channel === undefined) throw new Error("Pass `id`, `link`, or `channel`.");
      const page = await board.threadsPage({ ...query, after, limit: query.limit ?? 20 });
      return {
        cursor: page.cursor,
        older: page.older,
        threads: page.threads.map((thread) => ({
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
    description: `Reply in a board thread. When a board discussion started this session, your final message is already posted there as your reply: use this tool for other threads, to attach files, or for progress on a task you hold. Defaults to this session's thread. ${SHARED}`,
    inputSchema: z.object({
      id: messageId.optional(),
      text,
      attach,
      after: z
        .string()
        .min(1)
        .optional()
        .describe(
          "The last message you read in the thread. In a busy thread, the reply posts only if nothing landed after it; otherwise it fails with `newer_message`, so read what's new and decide again.",
        ),
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
        await board.reply(threadOrCurrent(id, ctx), {
          ...post,
          attachments,
          id: postId(ctx),
          text: text ?? "",
        }),
      );
    },
  });
}

/** Keeps a note in a thread, on the board only. */
export function defineBoardNoteTool(settings: Settings) {
  return defineTool({
    deferred: true,
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
    deferred: true,
    description:
      "Set or unset labels on a board message; labels on a thread's root apply to the whole thread. Use them to mark state others filter on, such as `status=done`. Labels under `board.` are the board's own.",
    inputSchema: z.object({
      id: z.string().min(1).describe("The message ID."),
      set: z.record(z.string(), z.string()).optional(),
      unset: z.array(z.string()).optional(),
      if: z
        .record(z.string(), z.string().nullable())
        .optional()
        .describe(
          "Change only while the message has these labels now, such as `{ status: 'open' }`; `null` means the label must be unset. Use it when others may change the same labels.",
        ),
    }),
    async execute({ id, set, unset, if: conditions }) {
      await client(settings).label(id, { if: conditions, set, unset });
      return { ok: true };
    },
  });
}

/** Schedules a message that wakes the agent later. */
export function defineBoardScheduleTool(settings: Settings) {
  return defineTool({
    deferred: true,
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
      return { id: schedule.id, next: schedule.next, re: schedule.re };
    },
  });
}

/** Cancels a scheduled message. */
export function defineBoardCancelScheduleTool(settings: Settings) {
  return defineTool({
    deferred: true,
    description:
      "Cancel a scheduled board message by its ID, such as once what it checks on has happened.",
    inputSchema: z.object({ id: z.string().min(1).describe("The schedule's ID.") }),
    async execute({ id }) {
      return await client(settings).cancelSchedule(id);
    },
  });
}

/** Lists pending scheduled messages. */
export function defineBoardSchedulesTool(settings: Settings) {
  return defineTool({
    deferred: true,
    description:
      "List pending scheduled board messages in a thread, by any message in it, or in a channel. Defaults to this session's thread, or outside one, to the messages you scheduled.",
    inputSchema: z.object({
      id: messageId.optional(),
      channel: z.string().min(1).optional(),
    }),
    async execute({ id, channel }, ctx) {
      const board = client(settings);
      const re = id ?? (channel === undefined ? currentThread(ctx) : undefined);
      const schedules = await board.schedules(
        re !== undefined
          ? { re }
          : channel !== undefined
            ? { channel }
            : { by: (await board.me()).actor },
      );
      return { schedules };
    },
  });
}

/** Lists the board's actors, to mention them. */
export function defineBoardActorsTool(settings: Settings) {
  return defineTool({
    deferred: true,
    description:
      "List people and agents on the board with their handles, to mention them as `@handle`, or to name a task owner by `id`. Pass `search` to narrow by handle or name.",
    inputSchema: z.object({
      search: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async execute({ search, limit }) {
      const needle = search?.toLowerCase();
      const actors = (await client(settings).actors()).filter(
        (actor) =>
          needle === undefined ||
          actor.handle.toLowerCase().includes(needle) ||
          actor.name.toLowerCase().includes(needle),
      );
      return { actors: actors.slice(0, limit ?? 50), total: actors.length };
    },
  });
}

/** Creates a task on the board's queue. */
export function defineBoardCreateTaskTool(settings: Settings) {
  return defineTool({
    deferred: true,
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

export function defineBoardCompleteTaskTool() {
  return defineTool({
    description:
      "Complete the board task you hold, with the result: what you did and the proof, such as a pull request link. Call it once the brief's check passes, as your last step.",
    inputSchema: z.object({ result: z.string().min(1).max(BOARD_TASK_NOTE_LIMIT).optional() }),
    async execute({ result }, ctx) {
      return settle(ctx, "completed", { result });
    },
  });
}

export function defineBoardFailTaskTool() {
  return defineTool({
    description:
      "Give up on the board task you hold, with why. Its owner can reopen it. Use it when the task can't be done as briefed.",
    inputSchema: z.object({ reason: z.string().min(1).max(BOARD_TASK_NOTE_LIMIT) }),
    async execute({ reason }, ctx) {
      return settle(ctx, "failed", { reason });
    },
  });
}

export function defineBoardBlockTaskTool() {
  return defineTool({
    description:
      "Hold the board task you hold for a person, with the one question they must answer: ask it in the thread with your recommendation first. Blocking ends your claim; once its owner answers and unblocks it, whoever claims it next reads the whole thread.",
    inputSchema: z.object({
      reason: z.string().min(1).max(BOARD_TASK_NOTE_LIMIT).describe("The question, in one line."),
      kind: z
        .string()
        .regex(BOARD_HOLD_KIND_PATTERN)
        .optional()
        .describe("What the hold is for, such as `needs_input` or `awaiting_approval`."),
    }),
    async execute({ reason, kind }, ctx) {
      return settle(ctx, "blocked", { kind, reason });
    },
  });
}

function configuring(settings: Settings, ctx: ToolContext) {
  assertConfigurer(settings, ctx);
  const config = settings();
  return { config, ...boardClients(config) };
}

function assertConfigurer(settings: Settings, ctx: ToolContext): void {
  const caller = ctx.session.auth?.current ?? null;
  const allowed = settings().configurers;
  if (allowed !== undefined) {
    const ids = [caller?.principalId, caller?.attributes.principal];
    if (caller !== null && ids.some((id) => typeof id === "string" && allowed.includes(id))) return;
    throw new Error(
      "Only the people this agent's `configurers` names may change its board watches. Ask one of them.",
    );
  }
  if (caller === null) {
    throw new Error(
      "Only a signed-in person may change this agent's board watches. Ask from a channel where you're signed in.",
    );
  }
  if (caller.authenticator === "board-watcher" && caller.attributes.actor_kind !== "person") {
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

/** Creates a watch: the board wakes the agent with these instructions when a message matches. */
export function defineBoardWatchTool(settings: Settings) {
  return defineTool({
    deferred: true,
    description:
      "Watch the board: from now on, every message in the channel that matches the filters wakes you in its board thread with these instructions, across conversations, cold starts, and redeploys. Use it when someone asks you to watch a channel and act on what's posted there. Keep it as narrow as the request. Returns the watch's ID.",
    inputSchema: z.object({
      channel: z
        .string()
        .min(1)
        .max(200)
        .describe("The channel to watch, such as `incidents`, or a subtree such as `work/`."),
      label: z
        .array(z.string().min(1).max(200))
        .max(10)
        .optional()
        .describe("Labels a message must have: `key`, or `key=value`."),
      by: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Only messages by this handle, such as `@ada`."),
      text: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Only messages containing these words, ignoring case."),
      instructions: z
        .string()
        .min(1)
        .max(BOARD_TEXT_LIMIT - 1_000)
        .describe(
          "What to do when it matches, written for a reader who remembers nothing of this conversation.",
        ),
      claim: queue.optional(),
    }),
    async execute({ instructions, claim, ...filter }, ctx) {
      const { config, deployment, watchChannel } = configuring(settings, ctx);
      const action: BoardWatchAction =
        claim === undefined ? { type: "converse" } : { queue: claim, type: "claim" };
      checkWatchScope({ action, can: config.can, channel: filter.channel, watchChannel });
      const watch = await createWatch({
        action,
        client: deployment,
        id: watchIdOf(ctx.session.id, ctx.callId),
        instructions,
        tail: tailOf(filter),
        watchChannel,
      });
      return { action: watch.action, id: watch.id, tail: watch.tail };
    },
  });
}

/** Lists the agent's watches. */
export function defineBoardWatchesTool(settings: Settings) {
  return defineTool({
    deferred: true,
    description:
      "List your board watches: each one's ID and what it matches, and with `details`, what it does.",
    inputSchema: z.object({
      details: z.boolean().optional().describe("Also read each watch's instructions and action."),
    }),
    async execute({ details }, ctx) {
      const { deployment, watchChannel } = configuring(settings, ctx);
      return {
        watches: await listWatches({ client: deployment, details: details === true, watchChannel }),
      };
    },
  });
}

/** Removes a watch. */
export function defineBoardUnwatchTool(settings: Settings) {
  return defineTool({
    deferred: true,
    description:
      "Stop a board watch by its ID: it no longer wakes you, and your other watches keep running.",
    inputSchema: z.object({
      id: z.string().regex(BOARD_NAME_PATTERN).describe("The watch's ID, such as `w-7k3p2q`."),
    }),
    async execute({ id }, ctx) {
      const { deployment, watchChannel } = configuring(settings, ctx);
      return await removeWatch({ client: deployment, id, watchChannel });
    },
  });
}
