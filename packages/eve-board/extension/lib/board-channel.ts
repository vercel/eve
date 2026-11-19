import { createHash } from "node:crypto";

import {
  defineChannel,
  POST,
  SessionStrandedError,
  type Channel,
  type ChannelContinuationOps,
  type ChannelFrom,
  type ChannelSendOptions,
  type ChannelSource,
  type MessageContent,
  type TurnPolicy,
  type UploadPolicyInput,
} from "eve/channels";
import { call as callOf, type Interaction } from "eve/events";
import {
  createLogger,
  postedIn,
  renderTextInteraction,
  surfaceEvents,
  type PromptQueueState,
  type SignInSurface,
} from "eve/internal/channels";

import {
  BOARD_TEXT_LIMIT,
  boardErrorCode,
  createBoardClient,
  resolveBoardTarget,
  type BoardCan,
  type BoardClaim,
  type BoardClaimedTask,
  type BoardClient,
  type BoardHeldClaim,
  type BoardMatch,
  type BoardMessage,
  type BoardPostOptions,
  type BoardSettings,
  type BoardThread,
} from "./client.ts";
import {
  boardMessageContent,
  boardSessionAddress,
  boardThreadId,
  defaultBoardAuth,
  fetchBoardAttachment,
  formatBoardContext,
  formatTaskContext,
  formatTaskFollowUpContext,
  formatWatchContext,
} from "./inbound.ts";
import {
  BOARD_WAKE_ROUTE,
  BoardWatchConfigError,
  checkQueueScope,
  CLAIM_LEASE_SECONDS,
  DEFAULT_WATCH_CHANNEL,
  allows,
  findWatchRecord,
  modelCan,
  type BoardWatchRecord,
} from "./watches.ts";

const log = createLogger("board.channel");

const MAX_PULLS_PER_WAKE = 20;
const MATCHES_PER_PULL = 10;
const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const SETTLEMENTS = new Set(["completed", "failed", "blocked"]);
const CLAIM_WATCH_LABEL = "eve-claim-watch";
const CLAIM_EVENTS = new Set([
  "task.assigned",
  "task.created",
  "task.expired",
  "task.ready",
  "task.released",
  "task.reopened",
  "task.unblocked",
]);

/** JSON-serializable state for one board thread's session. */
export interface BoardChannelState extends PromptQueueState {
  readonly channel: string | null;
  /** The thread's root message ID, which replies name. */
  readonly threadId: string | null;
  /** The watch whose match started the session. */
  readonly watch?: string | null;
  /** The message the current turn answers: `react()` targets it by default. */
  messageId: string | null;
  /** The task this session claimed, renewed while it works; `null` once it's settled or lost. */
  task?: BoardHeldClaim | null;
  /** Whether the current turn answers a board-only message, so its automatic replies stay off synced platforms. */
  noSync?: boolean;
  pendingSignIns?: Record<string, string>;
}

/** One board thread, as event handlers act on it. */
export interface BoardThreadHandle {
  /** The thread's root message ID. */
  readonly threadId: string;
  /** Replies in the thread as the configured profile. */
  reply(input: string | BoardPostOptions): Promise<BoardMessage>;
  /** Reacts to a message in the thread: the current turn's message by default. */
  react(
    emoji: string,
    options?: { readonly messageId?: string; readonly remove?: boolean },
  ): Promise<void>;
  /** Shows typing in the thread's synced platform threads; Slack shows `status`. */
  typing(status?: string): Promise<void>;
  /** Sets or unsets labels on the thread's root. */
  label(change: {
    readonly set?: Record<string, string>;
    readonly unset?: readonly string[];
  }): Promise<void>;
  /** Reads the whole thread. */
  read(): Promise<BoardThread>;
}

/** Channel-owned context rebuilt from persisted state. */
export interface BoardChannelContext {
  readonly board: BoardThreadHandle;
  state: BoardChannelState;
}

/** Event-handler context, including continuation routing. */
export interface BoardEventContext extends BoardChannelContext, ChannelContinuationOps {}

/**
 * Target accepted by `to(board, target)` for proactive sessions: an existing thread by any
 * message ID in it, or a new thread in a channel.
 */
export type BoardReceiveTarget =
  | { readonly thread: string }
  | {
      readonly channel: string;
      readonly text: string;
      readonly labels?: Readonly<Record<string, string>>;
    };

/** Configuration for {@link boardChannel}. */
export interface BoardChannelConfig extends BoardSettings {
  readonly turnPolicy?: TurnPolicy;
  /** Size and media-type limits for attachments eve downloads from the board. */
  readonly uploadPolicy?: UploadPolicyInput;
}

/** Concrete return type of {@link boardChannel}. */
export interface BoardChannel extends Channel<BoardChannelState, BoardReceiveTarget> {}

/**
 * A channel for Vercel Board. The board wakes it when a watch matches; each match runs the
 * watch's stored instructions in a session on the matching board thread, or first claims a
 * ready task and runs them on the task's thread. The agent's replies, reactions, and typing go
 * back to the thread, and from there to whatever Slack, GitHub, or Linear thread the board syncs.
 * Watches are created with the `watch` tool, never by the channel.
 */
export function boardChannel(config: BoardChannelConfig = {}): BoardChannel {
  return createBoardChannel(() => config, config);
}

export function createBoardChannel(
  settings: () => BoardSettings,
  options: Pick<BoardChannelConfig, "turnPolicy" | "uploadPolicy"> = {},
): BoardChannel {
  const client = () => {
    const config = settings();
    return createBoardClient(
      resolveBoardTarget({
        ...config,
        can: modelCan(config.can, config.watchChannel ?? DEFAULT_WATCH_CHANNEL),
      }),
    );
  };
  const deployment = () => createBoardClient(resolveBoardTarget({ ...settings(), can: undefined }));
  const watchChannel = () => settings().watchChannel ?? DEFAULT_WATCH_CHANNEL;

  const keepClaim = async (state: BoardChannelState) => {
    const claim = state.task;
    if (claim == null || !claimDue(claim)) return;
    state.task = await renewClaim(deployment(), claim);
  };

  let draining: { again: boolean } | undefined;
  const coalesced = (drain: () => Promise<number>): Promise<number> | undefined => {
    if (draining !== undefined) {
      draining.again = true;
      return undefined;
    }
    const current = { again: false };
    draining = current;
    return (async () => {
      let dispatched = 0;
      try {
        do {
          current.again = false;
          dispatched += await drain();
        } while (current.again);
      } finally {
        draining = undefined;
      }
      return dispatched;
    })();
  };

  const surface = surfaceEvents<BoardEventContext>({
    post: postChunks,
    restart: "thread",
    requests: { showOne: showPrompt },
    signIns: boardSignIns,
    typing: async (channel) => {
      await bestEffort("typing", () => channel.board.typing());
    },
  });

  const channel = defineChannel<BoardChannelState, BoardChannelContext, BoardReceiveTarget>({
    turnPolicy: options.turnPolicy,
    state: { channel: null, messageId: null, task: null, threadId: null },

    context(state) {
      return { board: threadHandle(client(), state.threadId ?? "", state), state };
    },

    metadata(state) {
      return {
        boardChannel: state.channel,
        boardTask: state.task == null ? null : { id: state.task.id, until: state.task.until },
        boardThread: state.threadId,
        boardWatch: state.watch ?? null,
      };
    },

    deliver(payload, ctx) {
      if (payload.state?.messageId != null) ctx.state.messageId = payload.state.messageId;
      if (payload.state?.task !== undefined) ctx.state.task = payload.state.task;
      if (payload.state?.noSync !== undefined) ctx.state.noSync = payload.state.noSync;
    },

    routes: [
      POST<BoardChannelState>(BOARD_WAKE_ROUTE, async (_request, { from, waitUntil }) => {
        const wake = coalesced(() =>
          drainMatches({
            can: settings().can,
            client: deployment(),
            from,
            name: settings().name,
            watchChannel,
          }),
        );
        if (wake !== undefined) {
          waitUntil(wake.catch((error) => logError("board wake-up failed", error)));
        }
        return Response.json({ ok: true }, { status: 202 });
      }),
    ],

    async receive({ message, target, ...send }, { from }) {
      const board = client();
      let root: BoardMessage;
      if ("thread" in target) {
        root = (await board.thread(target.thread)).message;
      } else {
        if (target.text.length === 0) {
          throw new Error("boardChannel().receive needs target.text to start a thread.");
        }
        root = await board.post(target.channel, {
          id: send.idempotencyKey === undefined ? undefined : postIdOf(send.idempotencyKey),
          labels: target.labels,
          text: target.text,
        });
      }
      return await sendRecovering(from(boardSessionAddress(board.profile, root)), message, {
        ...send,
        state: { channel: root.channel, messageId: root.id, noSync: false, threadId: root.id },
      });
    },

    fetchFile(url) {
      const policy = options.uploadPolicy;
      if (policy === "disabled") return Promise.resolve(null);
      return fetchBoardAttachment(url, client(), policy?.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES);
    },
    uploadPolicy: options.uploadPolicy,

    events: {
      ...surface,
      async "turn.started"(event, ctx) {
        await keepClaim(ctx.channel.state);
        await surface["turn.started"]?.(event, ctx);
      },
      async "call.requested"(event, ctx) {
        await keepClaim(ctx.channel.state);
        const { capability } = event.data;
        const status = capability.hidden === true ? undefined : capability.label;
        await bestEffort("typing", () => ctx.channel.board.typing(status));
      },
      async "call.settled"(event, ctx) {
        const { state } = ctx.channel;
        const claim = state.task;
        const call = ctx.view === undefined ? undefined : callOf(ctx.view, event.data.callId);
        const settlement =
          claim != null && event.data.outcome === "completed" && call !== undefined
            ? settlementOf(event.data.output, claim.id, call)
            : undefined;
        if (claim == null || settlement === undefined) {
          await keepClaim(state);
          return;
        }
        const { problem, retry } = await settleClaim(deployment(), claim, settlement);
        if (!retry) state.task = null;
        if (problem !== undefined)
          await bestEffort(
            "note",
            async () => void (await ctx.channel.board.reply({ noSync: true, text: problem })),
          );
      },
    },
  });

  return channel;
}

interface DrainInput {
  readonly can?: BoardCan;
  readonly client: BoardClient;
  readonly from: ChannelFrom<BoardChannelState>;
  readonly name: string | undefined;
  readonly wait?: number;
  readonly watchChannel: () => string;
}

export async function drainMatches(input: DrainInput): Promise<number> {
  const { client } = input;
  const wait = input.wait ?? 0;
  const self = await client.me();
  const records = new Map<string, Promise<BoardWatchRecord>>();
  const recordOf = (id: string) => {
    let record = records.get(id);
    if (record === undefined) {
      record = findWatchRecord({ client, id, self, watchChannel: input.watchChannel() });
      records.set(id, record);
    }
    return record;
  };

  let dispatched = 0;
  for (let pull = 0; pull < MAX_PULLS_PER_WAKE; pull += 1) {
    const matches = await client.matches({
      limit: MATCHES_PER_PULL,
      wait,
    });
    for (const match of matches) {
      if (await handleMatch({ ...input, match, recordOf, self })) dispatched += 1;
    }
    if (wait > 0 || matches.length === 0) break;
  }
  return dispatched;
}

async function handleMatch(
  input: DrainInput & {
    readonly match: BoardMatch;
    readonly self: { readonly principal: string; readonly actor: string };
    recordOf(id: string): Promise<BoardWatchRecord>;
  },
): Promise<boolean> {
  const { client, match } = input;
  try {
    const record = await input.recordOf(match.watcher);
    if (record.retired) {
      await client.ack(match, { skip: true });
      return false;
    }
    if (record.action.type === "claim") {
      try {
        checkQueueScope(record.action.queue, {
          can: input.can,
          watchChannel: input.watchChannel(),
        });
      } catch (error) {
        throw new BoardWatchConfigError(
          `Board watch ${record.id} claims outside this agent's scope: ${(error as Error).message}`,
        );
      }
    }
    const dispatched = await dispatch({ ...input, record });
    await client.ack(match);
    return dispatched;
  } catch (error) {
    const outcome =
      error instanceof BoardWatchConfigError
        ? (log.warn(error.message, { match: match.id }), { skip: true })
        : {
            error: `eve couldn't dispatch this match (error id ${logError("board match failed", error, { match: match.id })})`,
          };
    await client
      .ack(match, outcome)
      .catch((ackError) => logError("board ack failed", ackError, { match: match.id }));
    return false;
  }
}

async function dispatch(
  input: DrainInput & {
    readonly match: BoardMatch;
    readonly record: BoardWatchRecord;
    readonly self: { readonly principal: string; readonly actor: string };
  },
): Promise<boolean> {
  const { client, match, record } = input;
  const message = match.event.message;
  const watch = { name: input.name, watch: record.id };

  if (record.action.type === "claim") {
    if (match.event.type === "message.posted") {
      return message === undefined ? false : await followUp({ ...input, message });
    }
    if (!CLAIM_EVENTS.has(match.event.type)) return false;
    const { queue } = record.action;
    const claim = await client.claimReady({ ...queue, lease: CLAIM_LEASE_SECONDS });
    if (claim === null) return false;
    const { task } = claim;
    if (!allows(input.can, task.channel, "read") || !allows(input.can, task.channel, "label")) {
      await client.held(claim).release();
      log.warn("board watch claimed a task outside the agent's read scope; released it", {
        task: task.id,
        watch: record.id,
      });
      return false;
    }
    try {
      await client.label(task.id, { set: { [CLAIM_WATCH_LABEL]: record.id } });
      await sendRecovering(
        input.from(boardSessionAddress(record.id, task)),
        boardMessageContent(task),
        {
          auth: defaultBoardAuth(task, watch),
          context: [formatWatchContext(record), formatTaskContext(claim)],
          idempotencyKey: `board:task:${claim.taskId}:${claim.epoch}`,
          state: {
            channel: task.channel,
            messageId: task.id,
            noSync: task.noSync,
            task: heldClaimOf(claim),
            threadId: task.id,
            watch: record.id,
          },
        },
      );
    } catch (error) {
      await client
        .held(claim)
        .release()
        .catch((releaseError) =>
          logError("board task release failed", releaseError, { task: claim.taskId }),
        );
      throw error;
    }
    return true;
  }

  if (
    match.event.type !== "message.posted" ||
    message === undefined ||
    message.deleted ||
    postedBySelf(message, input)
  ) {
    return false;
  }
  if (!allows(input.can, message.channel, "read")) {
    log.warn("board watch matched a channel outside the agent's read scope; skipped it", {
      channel: message.channel,
      watch: record.id,
    });
    return false;
  }
  await sendRecovering(
    input.from(boardSessionAddress(record.id, message)),
    boardMessageContent(message),
    {
      auth: defaultBoardAuth(message, watch),
      context: [formatWatchContext(record), formatBoardContext(message)],
      idempotencyKey: `board:${match.id}`,
      state: {
        channel: message.channel,
        messageId: message.id,
        noSync: message.noSync,
        threadId: boardThreadId(message),
        watch: record.id,
      },
    },
  );
  return true;
}

async function followUp(
  input: DrainInput & {
    readonly match: BoardMatch;
    readonly message: BoardMessage;
    readonly record: BoardWatchRecord;
    readonly self: { readonly principal: string; readonly actor: string };
  },
): Promise<boolean> {
  const { client, match, message, record } = input;
  if (message.re === null || message.deleted || postedBySelf(message, input)) return false;
  const root = (await client.thread(message.re)).message;
  const claim = root.task?.claim;
  if (claim?.actor !== input.self.actor || Date.parse(claim.until) <= Date.now()) return false;
  if (root.labels[CLAIM_WATCH_LABEL] !== record.id) return false;
  if (!allows(input.can, message.channel, "read")) return false;
  await sendRecovering(
    input.from(boardSessionAddress(record.id, root)),
    boardMessageContent(message),
    {
      auth: defaultBoardAuth(message, { name: input.name, watch: record.id }),
      context: [formatWatchContext(record), formatTaskFollowUpContext(message)],
      idempotencyKey: `board:${match.id}`,
      state: {
        channel: message.channel,
        messageId: message.id,
        noSync: message.noSync,
        threadId: root.id,
        watch: record.id,
      },
    },
  );
  return true;
}

function postedBySelf(
  message: BoardMessage,
  input: { readonly client: BoardClient; readonly self: { readonly principal: string } },
): boolean {
  return (
    message.by.principal === input.self.principal &&
    message.by.profile === input.client.profile &&
    message.schedule === undefined
  );
}

async function sendRecovering(
  source: ChannelSource<BoardChannelState>,
  message: MessageContent,
  options: ChannelSendOptions<BoardChannelState>,
) {
  try {
    return await source.send(message, options);
  } catch (error) {
    if (!SessionStrandedError.is(error)) throw error;
    log.warn("board thread's session was stranded by an eve upgrade; starting a new one", {
      error,
    });
    await source.end({ reason: "Stranded by an eve upgrade; the board thread starts over." });
    return await source.send(message, options);
  }
}

function heldClaimOf(claim: BoardClaimedTask): BoardHeldClaim {
  return {
    epoch: claim.epoch,
    id: claim.taskId,
    lease: CLAIM_LEASE_SECONDS,
    token: claim.token,
    until: claim.until,
  };
}

function boardClaimOf(claim: BoardHeldClaim): BoardClaim {
  return { epoch: claim.epoch, taskId: claim.id, token: claim.token, until: claim.until };
}

function claimDue(claim: BoardHeldClaim, now = Date.now()): boolean {
  return Date.parse(claim.until) - now < (claim.lease * 1000) / 3;
}

async function renewClaim(
  client: BoardClient,
  claim: BoardHeldClaim,
): Promise<BoardHeldClaim | null> {
  try {
    const renewed = await client.held(boardClaimOf(claim)).renew(claim.lease);
    return { ...claim, epoch: renewed.epoch, token: renewed.token, until: renewed.until };
  } catch (error) {
    if (boardErrorCode(error) === "claim_lost") {
      log.warn("board task claim was lost; the agent no longer holds the task", {
        task: claim.id,
      });
      return null;
    }
    logError("board task renewal failed", error, { task: claim.id });
    return claim;
  }
}

export interface BoardSettlement {
  readonly settled: "completed" | "failed" | "blocked";
  readonly task: string;
  readonly result?: string;
  readonly reason?: string;
  readonly kind?: string;
}

const SETTLE_TOOL = /^(?:.+__)?(?:complete|fail|block)_task$/u;

export function settlementOf(
  output: unknown,
  taskId: string,
  capability: { readonly kind: string; readonly name: string },
): BoardSettlement | undefined {
  if (capability.kind !== "tool" || !SETTLE_TOOL.test(capability.name)) return undefined;
  if (typeof output !== "object" || output === null) return undefined;
  const settlement = output as Partial<BoardSettlement>;
  if (settlement.task !== taskId || !SETTLEMENTS.has(settlement.settled ?? "")) return undefined;
  return settlement as BoardSettlement;
}

export async function settleClaim(
  client: BoardClient,
  claim: BoardHeldClaim,
  settlement: BoardSettlement,
): Promise<{ readonly problem?: string; readonly retry: boolean }> {
  const held = client.held(boardClaimOf(claim));
  try {
    if (settlement.settled === "completed") await held.complete(settlement.result);
    else if (settlement.settled === "failed") await held.fail(settlement.reason ?? "Failed.");
    else await held.block(settlement.reason ?? "Needs a person.", { kind: settlement.kind });
    return { retry: false };
  } catch (error) {
    if (boardErrorCode(error) === "claim_lost") {
      return {
        problem: `eve couldn't mark task #${claim.id} ${settlement.settled}: its claim ended before the agent settled it.`,
        retry: false,
      };
    }
    logError("board task settlement failed", error, { task: claim.id });
    return {
      problem: `eve couldn't mark task #${claim.id} ${settlement.settled} on the board. Call the task tool again to retry.`,
      retry: true,
    };
  }
}

function threadHandle(
  client: BoardClient,
  threadId: string,
  state: { readonly messageId: string | null; readonly noSync?: boolean },
): BoardThreadHandle {
  return {
    threadId,
    reply: (post) =>
      client.reply(
        threadId,
        typeof post === "string" ? { noSync: state.noSync === true, text: post } : post,
      ),
    async react(emoji, options = {}) {
      const target = options.messageId ?? state.messageId ?? threadId;
      await client.react(target, emoji, { remove: options.remove });
    },
    typing: (status) => client.typing(threadId, status),
    label: (change) => client.label(threadId, change),
    read: () => client.thread(threadId),
  };
}

async function showPrompt(channel: BoardEventContext, request: Interaction): Promise<void> {
  const body = renderTextInteraction(request.request);
  const freeform =
    request.request.allowFreeform === true ? "\n\nYou can also reply with a custom answer." : "";
  await postChunks(channel, `${body}${freeform}\n\nReply in this thread to answer.`);
}

function boardSignIns(channel: BoardEventContext): SignInSurface {
  const post = async (text: string) => (await channel.board.reply(text)).id;
  return {
    post,
    postChallenge: async () => undefined,
    postStatus: (signIn) =>
      post(
        `Authorization required for ${signIn.displayName}. Board threads are shared, so connect it through a private channel with this agent, then reply here.`,
      ),
    posted: postedIn(channel.state, "pendingSignIns"),
    private: false,
  };
}

async function postChunks(channel: BoardEventContext, text: string): Promise<void> {
  for (const chunk of splitBoardText(text)) await channel.board.reply(chunk);
}

export function splitBoardText(text: string, limit = BOARD_TEXT_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const cut = rest.lastIndexOf("\n", limit);
    let end = cut > limit / 2 ? cut : limit;
    const last = rest.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end).replace(/^\n/u, "");
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

async function bestEffort(what: string, act: () => Promise<void>): Promise<void> {
  try {
    await act();
  } catch (error) {
    logError(`board ${what} failed — swallowed`, error);
  }
}

function logError(message: string, error: unknown, fields: Record<string, unknown> = {}): string {
  const errorId = crypto.randomUUID();
  log.error(message, { ...fields, error, errorId });
  return errorId;
}

function postIdOf(idempotencyKey: string): string {
  return `eve-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}`;
}
