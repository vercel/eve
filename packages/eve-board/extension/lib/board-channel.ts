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
  lookupBoard,
  resolveBoards,
  resolveSessionBoard,
  selectBoard,
  type ResolvedBoardConfig,
} from "./boards.ts";
import {
  BOARD_TEXT_LIMIT,
  boardAllows,
  boardErrorCode,
  boardPostId,
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
  DEFAULT_BOARD_ROUTE_BASE,
  LEGACY_BOARD_WAKE_ROUTE,
  normalizeBoardRouteBase,
} from "./route.ts";
import {
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
const RECENT_RENEWAL_MS = 60_000;
const SETTLE_ATTEMPTS = 3;
const SETTLE_BACKOFF_MS = 500;
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
  /** The configured board key for this session, or omitted on a shorthand mount. */
  readonly board?: string | null;
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
 * message ID in it, or a new thread in a channel. Pass `board` when multiple boards are configured.
 */
export type BoardReceiveTarget =
  | { readonly board?: string; readonly thread: string }
  | {
      readonly board?: string;
      readonly channel: string;
      readonly text: string;
      readonly labels?: Readonly<Record<string, string>>;
    };

/** How the board channel runs turns and downloads attachments. Board settings come from the extension's configuration. */
export interface BoardChannelConfig {
  /** Base route path for the board wake endpoint (`<route>/wake` or `<route>/:board/wake`). Defaults to the extension's `route` or `"/eve/v1/board"`. */
  readonly route?: string;
  readonly turnPolicy?: TurnPolicy;
  /** Size and media-type limits for attachments eve downloads from the board. */
  readonly uploadPolicy?: UploadPolicyInput;
}

/** What the board channel reports about a session to tools, hooks, and instrumentation. */
export interface BoardChannelMetadata extends Record<string, unknown> {
  /** The configured board key for this session, or `null` for a shorthand mount. */
  readonly board: string | null;
  /** The board channel the session's thread is in. */
  readonly boardChannel: string | null;
  /** The task the session holds, with when its claim ends, or `null`. */
  readonly boardTask: { readonly id: string; readonly until: string } | null;
  /** The root message ID of the session's thread. */
  readonly boardThread: string | null;
  /** The watch whose match started the session. */
  readonly boardWatch: string | null;
}

/** The board channel's type. */
export interface BoardChannel extends Channel<
  BoardChannelState,
  BoardReceiveTarget,
  BoardChannelMetadata
> {}

export function createBoardChannel(
  settings: () => BoardSettings,
  options: BoardChannelConfig = {},
): BoardChannel {
  const deploymentFor = (state: BoardChannelState) =>
    boardClients(resolveSessionBoard(settings(), state.board)).deployment;
  const keepClaim = (state: BoardChannelState) => keepBoardClaim(deploymentFor(state), state);

  const draining = new Map<string, { again: boolean }>();
  const coalesced = (key: string, drain: () => Promise<number>): Promise<number> | undefined => {
    const existing = draining.get(key);
    if (existing !== undefined) {
      existing.again = true;
      return undefined;
    }
    const current = { again: false };
    draining.set(key, current);
    return (async () => {
      let dispatched = 0;
      try {
        do {
          current.again = false;
          dispatched += await drain();
        } while (current.again);
      } finally {
        if (draining.get(key) === current) draining.delete(key);
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

  const routeBase = normalizeBoardRouteBase(options.route ?? settings().route);
  const wakeTarget = (
    board: ResolvedBoardConfig,
    from: ChannelFrom<BoardChannelState>,
    waitUntil: (promise: Promise<unknown>) => void,
  ) => {
    const wake = coalesced(board.key, () => drainMatches({ board, from }));
    if (wake !== undefined) {
      waitUntil(
        wake.catch((error) => logError("board wake-up failed", error, { board: board.key })),
      );
    }
    return Response.json({ ok: true }, { status: 202 });
  };
  const handleShorthandWake = async (
    _request: Request,
    {
      from,
      waitUntil,
    }: {
      readonly from: ChannelFrom<BoardChannelState>;
      readonly waitUntil: (promise: Promise<unknown>) => void;
    },
  ) => {
    const resolved = resolveBoards(settings());
    if (!resolved.shorthand) {
      return Response.json({ error: "Board key is required.", ok: false }, { status: 404 });
    }
    return wakeTarget(resolved.byKey.values().next().value!, from, waitUntil);
  };
  const handleNamedWake = async (
    _request: Request,
    {
      from,
      params,
      waitUntil,
    }: {
      readonly from: ChannelFrom<BoardChannelState>;
      readonly params: Readonly<Record<string, string>>;
      readonly waitUntil: (promise: Promise<unknown>) => void;
    },
  ) => {
    const resolved = resolveBoards(settings());
    if (resolved.shorthand) {
      return Response.json({ error: "Unknown board.", ok: false }, { status: 404 });
    }
    const boardKey = params.board;
    const target = boardKey === undefined ? undefined : lookupBoard(resolved, boardKey);
    if (target === undefined) {
      return Response.json({ error: "Unknown board.", ok: false }, { status: 404 });
    }
    return wakeTarget(target, from, waitUntil);
  };
  const routes = [
    POST<BoardChannelState>(`${routeBase}/wake`, handleShorthandWake),
    POST<BoardChannelState>(`${routeBase}/:board/wake`, handleNamedWake),
    ...(routeBase === DEFAULT_BOARD_ROUTE_BASE
      ? [POST<BoardChannelState>(LEGACY_BOARD_WAKE_ROUTE, handleShorthandWake)]
      : []),
  ];

  const channel = defineChannel<
    BoardChannelState,
    BoardChannelContext,
    BoardReceiveTarget,
    BoardChannelMetadata
  >({
    turnPolicy: options.turnPolicy,
    state: { channel: null, task: null, threadId: null },

    context(state) {
      const target = resolveSessionBoard(settings(), state.board);
      return { board: threadHandle(boardClients(target).model, state), state };
    },

    metadata(state): BoardChannelMetadata {
      return {
        board: state.board ?? null,
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

    routes,

    async receive({ message, target, ...send }, { from }) {
      const resolved = selectBoard(resolveBoards(settings()), target.board, undefined);
      const board = boardClients(resolved).model;
      let root: BoardMessage;
      if ("thread" in target) {
        root = (await board.thread(target.thread)).message;
      } else {
        if (target.text.length === 0) {
          throw new Error("boardChannel().receive needs target.text to start a thread.");
        }
        root = await board.post(target.channel, {
          id: send.idempotencyKey === undefined ? undefined : boardPostId(send.idempotencyKey),
          labels: target.labels,
          text: target.text,
        });
      }
      const boardKey = resolved.shorthand ? undefined : resolved.key;
      return await sendRecovering(
        from(boardSessionAddress(board.profile, root, boardKey)),
        message,
        {
          ...send,
          state: {
            ...(boardKey !== undefined && { board: boardKey }),
            channel: root.channel,
            noSync: false,
            threadId: root.id,
          },
        },
      );
    },

    fetchFile(url) {
      const policy = options.uploadPolicy;
      if (policy === "disabled") return Promise.resolve(null);
      return fetchBoardAttachment(
        url,
        (boardKey) => {
          const set = resolveBoards(settings());
          const target =
            boardKey === undefined
              ? set.byKey.size === 1
                ? set.byKey.values().next().value
                : undefined
              : lookupBoard(set, boardKey);
          return target === undefined ? undefined : boardClients(target).model;
        },
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
          renewDuringCall(
            () => deploymentFor(ctx.channel.state),
            ctx.channel.state,
            event.data.callId,
          );
        } else {
          await renewBeforeTask(deploymentFor(ctx.channel.state), ctx.channel.state);
        }
      },
      async "call.settled"(event, ctx) {
        endRenewal(ctx.channel.state, event.data.callId);
        await settleAfterCall(deploymentFor(ctx.channel.state), ctx.channel, ctx.view, event.data);
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
  readonly boardKey: string | undefined;
  readonly can?: BoardCan;
  readonly deployment: BoardClient;
  readonly key: string;
  readonly model: BoardClient;
  readonly from: ChannelFrom<BoardChannelState>;
  readonly name: string | undefined;
  readonly self: { readonly actor: string };
  readonly shorthand: boolean;
  readonly watchChannel: string;
  recordOf(id: string): Promise<BoardWatchRecord>;
}

export async function drainMatches(
  options:
    | {
        readonly board: ResolvedBoardConfig;
        readonly from: ChannelFrom<BoardChannelState>;
        readonly wait?: number;
      }
    | {
        readonly settings: BoardSettings;
        readonly board?: string;
        readonly from: ChannelFrom<BoardChannelState>;
        readonly wait?: number;
      },
): Promise<number> {
  const target =
    "settings" in options
      ? selectBoard(resolveBoards(options.settings), options.board, undefined)
      : options.board;
  const { deployment, model, watchChannel } = boardClients(target);
  const self = await deployment.me();
  const records = new Map<string, Promise<BoardWatchRecord>>();
  const wake: Wake = {
    boardKey: target.shorthand ? undefined : target.key,
    can: target.can,
    deployment,
    from: options.from,
    key: target.key,
    model,
    name: target.name,
    recordOf(id) {
      let record = records.get(id);
      if (record === undefined) {
        record = findWatchRecord({ client: deployment, id, self, watchChannel });
        records.set(id, record);
      }
      return record;
    },
    self,
    shorthand: target.shorthand,
    watchChannel,
  };
  const wait = options.wait ?? 0;
  let dispatched = 0;
  for (let pull = 0; pull < MAX_PULLS_PER_WAKE; pull += 1) {
    const matches = await deployment
      .matches({ limit: MATCHES_PER_PULL, wait })
      .catch((error: unknown) => {
        if (boardErrorCode(error) === "no_registration") return [];
        throw error;
      });
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
  const { boardKey, can, deployment, self } = wake;
  const posted = match.event.message;
  if (posted !== undefined && coversChannel(wake.watchChannel, posted.channel)) return false;
  const idempotencyPrefix = boardKey === undefined ? "board" : `board:${boardKey}`;
  const start = (
    message: BoardMessage,
    context: string,
    idempotencyKey: string,
    task?: BoardClaim,
  ) =>
    sendRecovering(
      wake.from(boardSessionAddress(record.id, message, boardKey)),
      boardMessageContent(message, boardKey),
      {
        auth: defaultBoardAuth(message, {
          key: wake.key,
          name: wake.name,
          shorthand: wake.shorthand,
          watch: record.id,
        }),
        context: [formatWatchContext(record, boardKey), context],
        idempotencyKey,
        state: {
          ...(boardKey !== undefined && { board: boardKey }),
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
        ...(boardKey !== undefined && { board: boardKey }),
        channel: posted.channel,
        watch: record.id,
      });
      return false;
    }
    if (record.action.type !== "claim") {
      await start(posted, formatBoardContext(posted, boardKey), `${idempotencyPrefix}:${match.id}`);
      return true;
    }
    if (posted.re === null) return false;
    const root = (await deployment.thread(posted.re)).message;
    const held = root.task?.claim;
    if (held?.actor !== self.actor || Date.parse(held.until) <= Date.now()) return false;
    if (root.labels[CLAIM_WATCH_LABEL] !== record.id) return false;
    await start(
      posted,
      formatTaskFollowUpContext(posted, boardKey),
      `${idempotencyPrefix}:${match.id}`,
    );
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
      ...(boardKey !== undefined && { board: boardKey }),
      task: task.id,
      watch: record.id,
    });
    return false;
  }
  try {
    await deployment.label(task.id, { set: { [CLAIM_WATCH_LABEL]: record.id } });
    await start(
      task,
      formatTaskContext(claimed, boardKey),
      `${idempotencyPrefix}:task:${task.id}:${claim.epoch}`,
      claim,
    );
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

function renewedRecently(claim: BoardClaim, now = Date.now()): boolean {
  return Date.parse(claim.until) - now > CLAIM_LEASE_SECONDS * 1000 - RECENT_RENEWAL_MS;
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
  }, RENEW_EVERY_MS);
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
  if (state.task != null && claimDue(state.task)) await renewBoardClaim(client, state);
}

export async function renewBeforeTask(
  client: BoardClient,
  state: BoardChannelState,
): Promise<void> {
  if (state.task != null && !renewedRecently(state.task)) await renewBoardClaim(client, state);
}

async function renewBoardClaim(client: BoardClient, state: BoardChannelState): Promise<void> {
  const claim = state.task;
  if (claim == null) return;
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
  const { problem } = await settleClaim(client, claim, settlement);
  state.task = null;
  stopRenewal(claim.token);
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
): Promise<{ readonly problem?: string }> {
  const held = client.held(claim);
  for (let attempt = 1; ; attempt += 1) {
    try {
      if (settlement.settled === "completed") await held.complete(settlement.result);
      else if (settlement.settled === "failed") await held.fail(settlement.reason ?? "Failed.");
      else await held.block(settlement.reason ?? "Needs a person.", { kind: settlement.kind });
      return {};
    } catch (error) {
      if (boardErrorCode(error) === "claim_lost") {
        return {
          problem: `eve couldn't mark task #${claim.taskId} ${settlement.settled}: its claim ended before the agent settled it.`,
        };
      }
      const id = logError("board task settlement failed", error, { task: claim.taskId, attempt });
      if (temporaryBoardFailure(error) && attempt < SETTLE_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, attempt * SETTLE_BACKOFF_MS));
        continue;
      }
      return {
        problem: `eve couldn't mark task #${claim.taskId} ${settlement.settled} on the board (error id ${id}). Its claim runs out within the hour, and the task goes back to the queue.`,
      };
    }
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
