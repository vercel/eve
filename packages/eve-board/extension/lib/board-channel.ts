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
import { call as callOf, type Interaction, type SessionView } from "eve/events";
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
  boardAllows,
  boardErrorCode,
  type BoardCan,
  type BoardClaim,
  type BoardClient,
  type BoardMatch,
  type BoardMessage,
  type BoardPostOptions,
  type BoardSettings,
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
  boardClients,
  BoardWatchConfigError,
  checkQueueScope,
  coversChannel,
  findWatchRecord,
  type BoardWatchRecord,
} from "./watches.ts";

const log = createLogger("board.channel");

const CLAIM_LEASE_SECONDS = 3600;
const RENEW_EVERY_MS = 30_000;
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
  /** The task this session claimed, renewed while it works; `null` once it's settled or lost. */
  task?: BoardClaim | null;
  /** Whether the current turn answers a board-only message, so its automatic replies stay off synced platforms. */
  noSync?: boolean;
  pendingSignIns?: Record<string, string>;
}

export interface BoardThreadHandle {
  reply(input: string | BoardPostOptions): Promise<BoardMessage>;
  typing(status?: string): Promise<void>;
}

export interface BoardChannelContext {
  readonly board: BoardThreadHandle;
  state: BoardChannelState;
}

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
export interface BoardChannelConfig extends Omit<BoardSettings, "configurers"> {
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
  const deployment = () => boardClients(settings()).deployment;
  const keepClaim = (state: BoardChannelState) => keepBoardClaim(deployment(), state);

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
    state: { channel: null, task: null, threadId: null },

    context(state) {
      return { board: threadHandle(boardClients(settings()).model, state), state };
    },

    metadata(state) {
      return {
        boardChannel: state.channel,
        boardTask: state.task == null ? null : { id: state.task.taskId, until: state.task.until },
        boardThread: state.threadId,
        boardWatch: state.watch ?? null,
      };
    },

    deliver(payload, ctx) {
      if (payload.state?.task !== undefined) ctx.state.task = payload.state.task;
      if (payload.state?.noSync !== undefined) ctx.state.noSync = payload.state.noSync;
    },

    routes: [
      POST<BoardChannelState>(BOARD_WAKE_ROUTE, async (_request, { from, waitUntil }) => {
        const wake = coalesced(() => drainMatches({ from, settings: settings() }));
        if (wake !== undefined) {
          waitUntil(wake.catch((error) => logError("board wake-up failed", error)));
        }
        return Response.json({ ok: true }, { status: 202 });
      }),
    ],

    async receive({ message, target, ...send }, { from }) {
      const board = boardClients(settings()).model;
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
        state: { channel: root.channel, noSync: false, threadId: root.id },
      });
    },

    fetchFile(url) {
      const policy = options.uploadPolicy;
      if (policy === "disabled") return Promise.resolve(null);
      return fetchBoardAttachment(
        url,
        boardClients(settings()).model,
        policy?.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES,
      );
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
      async "call.started"(event, ctx) {
        if (event.data.taskId === undefined) {
          renewDuringCall(deployment, ctx.channel.state, event.data.callId);
        }
      },
      async "call.settled"(event, ctx) {
        endRenewal(ctx.channel.state, event.data.callId);
        await settleAfterCall(deployment(), ctx.channel, ctx.view, event.data);
      },
      async "turn.settled"(event, ctx) {
        endRenewal(ctx.channel.state);
        await surface["turn.settled"](event, ctx);
      },
    },
  });

  return channel;
}

interface Wake {
  readonly can?: BoardCan;
  readonly deployment: BoardClient;
  readonly model: BoardClient;
  readonly from: ChannelFrom<BoardChannelState>;
  readonly name: string | undefined;
  readonly self: { readonly actor: string };
  readonly watchChannel: string;
  recordOf(id: string): Promise<BoardWatchRecord>;
}

export async function drainMatches(options: {
  readonly settings: BoardSettings;
  readonly from: ChannelFrom<BoardChannelState>;
  readonly wait?: number;
}): Promise<number> {
  const { settings } = options;
  const { deployment, model, watchChannel } = boardClients(settings);
  const self = await deployment.me();
  const records = new Map<string, Promise<BoardWatchRecord>>();
  const wake: Wake = {
    can: settings.can,
    deployment,
    from: options.from,
    model,
    name: settings.name,
    recordOf(id) {
      let record = records.get(id);
      if (record === undefined) {
        record = findWatchRecord({ client: deployment, id, self, watchChannel });
        records.set(id, record);
      }
      return record;
    },
    self,
    watchChannel,
  };
  const wait = options.wait ?? 0;
  let dispatched = 0;
  for (let pull = 0; pull < MAX_PULLS_PER_WAKE; pull += 1) {
    const matches = await deployment.matches({ limit: MATCHES_PER_PULL, wait });
    for (const match of matches) if (await handleMatch(wake, match)) dispatched += 1;
    if (wait > 0 || matches.length === 0) break;
  }
  return dispatched;
}

async function handleMatch(wake: Wake, match: BoardMatch): Promise<boolean> {
  const { deployment } = wake;
  try {
    const record = await wake.recordOf(match.watcher);
    if (record.retired) {
      await deployment.ack(match, { skip: true });
      return false;
    }
    if (record.action.type === "claim") {
      try {
        checkQueueScope(record.action.queue, wake);
      } catch (error) {
        throw new BoardWatchConfigError(
          `Board watch ${record.id} claims outside this agent's scope: ${(error as Error).message}`,
        );
      }
    }
    const dispatched = await dispatch(wake, match, record);
    await deployment.ack(match);
    return dispatched;
  } catch (error) {
    const misconfigured = error instanceof BoardWatchConfigError;
    if (misconfigured) log.warn(error.message, { match: match.id });
    const outcome = misconfigured
      ? { skip: true }
      : {
          error: `eve couldn't dispatch this match (error id ${logError("board match failed", error, { match: match.id })})`,
        };
    await deployment
      .ack(match, outcome)
      .catch((ackError) => logError("board ack failed", ackError, { match: match.id }));
    return false;
  }
}

async function dispatch(wake: Wake, match: BoardMatch, record: BoardWatchRecord): Promise<boolean> {
  const { can, deployment, self } = wake;
  const posted = match.event.message;
  if (posted !== undefined && coversChannel(wake.watchChannel, posted.channel)) return false;
  const start = (
    message: BoardMessage,
    context: string,
    idempotencyKey: string,
    task?: BoardClaim,
  ) =>
    sendRecovering(
      wake.from(boardSessionAddress(record.id, message)),
      boardMessageContent(message),
      {
        auth: defaultBoardAuth(message, { name: wake.name, watch: record.id }),
        context: [formatWatchContext(record), context],
        idempotencyKey,
        state: {
          channel: message.channel,
          noSync: message.noSync,
          threadId: boardThreadId(message),
          watch: record.id,
          ...(task !== undefined && { task }),
        },
      },
    );

  if (match.event.type === "message.posted") {
    if (posted === undefined || posted.deleted) return false;
    if (posted.by.actor === self.actor && posted.schedule === undefined) return false;
    if (!boardAllows(can, posted.channel, "read")) {
      log.warn("board watch matched a channel outside the agent's read scope; skipped it", {
        channel: posted.channel,
        watch: record.id,
      });
      return false;
    }
    if (record.action.type !== "claim") {
      await start(posted, formatBoardContext(posted), `board:${match.id}`);
      return true;
    }
    if (posted.re === null) return false;
    const root = (await deployment.thread(posted.re)).message;
    const held = root.task?.claim;
    if (held?.actor !== self.actor || Date.parse(held.until) <= Date.now()) return false;
    if (root.labels[CLAIM_WATCH_LABEL] !== record.id) return false;
    await start(posted, formatTaskFollowUpContext(posted), `board:${match.id}`);
    return true;
  }

  if (record.action.type !== "claim" || !CLAIM_EVENTS.has(match.event.type)) return false;
  const claimed = await wake.model.claimReady({
    ...record.action.queue,
    lease: CLAIM_LEASE_SECONDS,
  });
  if (claimed === null) return false;
  const { task, ...claim } = claimed;
  if (!boardAllows(can, task.channel, "read") || !boardAllows(can, task.channel, "label")) {
    await deployment.held(claim).release();
    log.warn("board watch claimed a task outside the agent's read scope; released it", {
      task: task.id,
      watch: record.id,
    });
    return false;
  }
  try {
    await deployment.label(task.id, { set: { [CLAIM_WATCH_LABEL]: record.id } });
    await start(task, formatTaskContext(claimed), `board:task:${task.id}:${claim.epoch}`, claim);
  } catch (error) {
    await deployment
      .held(claim)
      .release()
      .catch((releaseError) =>
        logError("board task release failed", releaseError, { task: task.id }),
      );
    throw error;
  }
  return true;
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

function temporaryBoardFailure(error: unknown): boolean {
  const status = (error as { readonly status?: unknown } | null)?.status;
  return typeof status !== "number" || status === 429 || status >= 500;
}

function claimDue(claim: BoardClaim, now = Date.now()): boolean {
  return Date.parse(claim.until) - now < (CLAIM_LEASE_SECONDS * 1000) / 3;
}

async function renewClaim(client: BoardClient, claim: BoardClaim): Promise<BoardClaim | null> {
  try {
    return { ...claim, until: await client.held(claim).renew(CLAIM_LEASE_SECONDS) };
  } catch (error) {
    if (boardErrorCode(error) === "claim_lost") {
      log.warn("board task claim was lost; the agent no longer holds the task", {
        task: claim.taskId,
      });
      return null;
    }
    logError("board task renewal failed", error, { task: claim.taskId });
    return claim;
  }
}

interface ClaimRenewal {
  readonly calls: Set<string>;
  claim: BoardClaim | null;
  renewing: boolean;
  timer?: ReturnType<typeof setInterval>;
}

const renewals = new Map<string, ClaimRenewal>();

export function renewDuringCall(
  client: () => BoardClient,
  state: BoardChannelState,
  callId: string,
  everyMs = RENEW_EVERY_MS,
): void {
  const claim = state.task;
  if (claim == null) return;
  const running = renewals.get(claim.token);
  if (running !== undefined) {
    running.calls.add(callId);
    return;
  }
  const renewal: ClaimRenewal = { calls: new Set([callId]), claim, renewing: false };
  renewal.timer = setInterval(async () => {
    if (renewal.renewing || renewal.claim === null || !claimDue(renewal.claim)) return;
    renewal.renewing = true;
    try {
      renewal.claim = await renewClaim(client(), renewal.claim);
    } finally {
      renewal.renewing = false;
    }
    if (renewal.claim === null) clearInterval(renewal.timer);
  }, everyMs);
  renewal.timer.unref?.();
  renewals.set(claim.token, renewal);
}

function stopRenewal(token: string): void {
  clearInterval(renewals.get(token)?.timer);
  renewals.delete(token);
}

export function endRenewal(state: BoardChannelState, callId?: string): void {
  const token = state.task?.token;
  const renewal = token === undefined ? undefined : renewals.get(token);
  if (token === undefined || renewal === undefined) return;
  if (callId !== undefined) renewal.calls.delete(callId);
  state.task = renewal.claim;
  if (callId === undefined || renewal.calls.size === 0 || renewal.claim === null)
    stopRenewal(token);
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

export async function keepBoardClaim(client: BoardClient, state: BoardChannelState): Promise<void> {
  const claim = state.task;
  if (claim == null || !claimDue(claim)) return;
  state.task = await renewClaim(client, claim);
  if (state.task === null) stopRenewal(claim.token);
}

export async function settleAfterCall(
  client: BoardClient,
  channel: Pick<BoardEventContext, "board" | "state">,
  view: SessionView | undefined,
  call: { readonly callId: string; readonly outcome: string; readonly output?: unknown },
): Promise<void> {
  const { state } = channel;
  const claim = state.task;
  const observed = view === undefined ? undefined : callOf(view, call.callId);
  const settlement =
    claim != null && call.outcome === "completed" && observed !== undefined
      ? settlementOf(call.output, claim.taskId, observed)
      : undefined;
  if (claim == null || settlement === undefined) {
    await keepBoardClaim(client, state);
    return;
  }
  const { problem, retry } = await settleClaim(client, claim, settlement);
  if (!retry) {
    state.task = null;
    stopRenewal(claim.token);
  }
  if (problem !== undefined) {
    await bestEffort(
      "note",
      async () => void (await channel.board.reply({ noSync: true, text: problem })),
    );
  }
}

export async function settleClaim(
  client: BoardClient,
  claim: BoardClaim,
  settlement: BoardSettlement,
): Promise<{ readonly problem?: string; readonly retry: boolean }> {
  const held = client.held(claim);
  try {
    if (settlement.settled === "completed") await held.complete(settlement.result);
    else if (settlement.settled === "failed") await held.fail(settlement.reason ?? "Failed.");
    else await held.block(settlement.reason ?? "Needs a person.", { kind: settlement.kind });
    return { retry: false };
  } catch (error) {
    if (boardErrorCode(error) === "claim_lost") {
      return {
        problem: `eve couldn't mark task #${claim.taskId} ${settlement.settled}: its claim ended before the agent settled it.`,
        retry: false,
      };
    }
    const id = logError("board task settlement failed", error, { task: claim.taskId });
    if (!temporaryBoardFailure(error)) {
      return {
        problem: `The board refused to mark task #${claim.taskId} ${settlement.settled} (error id ${id}). Its claim lapses on its own, and the task goes back to the queue.`,
        retry: false,
      };
    }
    return {
      problem: `eve couldn't mark task #${claim.taskId} ${settlement.settled} on the board. Call the task tool again to retry.`,
      retry: true,
    };
  }
}

function threadHandle(
  client: BoardClient,
  state: Pick<BoardChannelState, "threadId" | "noSync">,
): BoardThreadHandle {
  const threadId = state.threadId ?? "";
  return {
    reply: (post) =>
      client.reply(
        threadId,
        typeof post === "string" ? { noSync: state.noSync === true, text: post } : post,
      ),
    typing: (status) => client.typing(threadId, status),
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
