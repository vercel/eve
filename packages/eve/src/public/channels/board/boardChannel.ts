import { setChannelStartHook } from "#channel/compiled-channel.js";
import { SessionStrandedError } from "#channel/session-stranded-error.js";
import type {
  ChannelFrom,
  ChannelSendOptions,
  ChannelSource,
} from "#channel/channel-operations.js";
import type { Interaction } from "#channel/interaction-prompts.js";
import type { PromptQueueState } from "#channel/prompt-queue.js";
import { renderTextInteraction } from "#channel/resolve-text.js";
import { postedIn, type SignInSurface } from "#channel/sign-in.js";
import { surfaceEvents } from "#channel/surface.js";
import type { SessionAuthContext, TurnPolicy } from "#channel/types.js";
import { createLogger, logError } from "#internal/logging.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { MessageContent } from "#shared/message-content.js";
import {
  createBoardClient,
  type BoardClaimedTask,
  type BoardClient,
  type BoardMatch,
  type BoardMessage,
  type BoardPostOptions,
  type BoardTarget,
  type BoardThread,
} from "#public/channels/board/client.js";
import {
  boardMessageContent,
  boardSessionAddress,
  boardThreadId,
  defaultBoardAuth,
  fetchBoardAttachment,
  formatBoardContext,
  formatTaskContext,
  formatTaskFollowUpContext,
} from "#public/channels/board/inbound.js";
import {
  BOARD_WAKE_ROUTE,
  hostedEnvironment,
  publicBoardRoute,
  reachedOnWakeHost,
  reconcileRegistration,
  type BoardWatcherConfig,
} from "#public/channels/board/registration.js";
import {
  BOARD_WORKER_WATCHER,
  claimDue,
  dispatchWork,
  heldClaimOf,
  holdUnsettled,
  renewClaim,
  resolveBoardWorker,
  taskSettlementOf,
  type BoardHeldClaim,
  type BoardWorker,
  type ResolvedBoardWorker,
} from "#public/channels/board/worker.js";
import { mergeUploadPolicy, type UploadPolicyInput } from "#public/channels/upload-policy.js";
import {
  defineChannel,
  POST,
  type Channel,
  type ChannelContinuationOps,
  type ChannelEventContext,
  type ChannelEventOf,
  type CommittedLine,
} from "#public/definitions/channel.js";

const log = createLogger("board.channel");

export const DEFAULT_BOARD_PROFILE = "eve";
export const BOARD_TEXT_LIMIT = 10_000;
/** A board profile: a letter, then up to 31 letters, numbers, or hyphens. */
export const BOARD_PROFILE_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,31}$/u;
const BOARD_POLL_HEADER = "x-eve-board-poll";
const MAX_PULLS_PER_WAKE = 20;
const MATCHES_PER_PULL = 10;
const POLL_WAIT_SECONDS = 25;
const MAX_WATCHERS = 32;

/** JSON-serializable state for one board thread's session. */
export interface BoardChannelState extends PromptQueueState {
  readonly channel: string | null;
  /** The thread's root message ID, which replies name. */
  readonly threadId: string | null;
  /** The watcher whose match started the session, or `"worker"` for a claimed task. */
  readonly watcher?: string | null;
  /** The message the current turn answers: `react()` targets it by default. */
  messageId: string | null;
  /** The task claim a worker session holds, renewed while it works; `null` once it's settled or lost. */
  task?: BoardHeldClaim | null;
  pendingSignIns?: Record<string, string>;
}

/** One board thread, as event handlers and hooks act on it. */
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

/** What `onMessage` gets beside the message. */
export interface BoardMessageContext {
  /** The board's name, or `undefined` for the team's default board. */
  readonly name: string | undefined;
  /** The watcher that matched the message. */
  readonly watcher: string;
  /** The message's thread. */
  readonly board: BoardThreadHandle;
}

/**
 * Result of `onMessage`. Return `null` to acknowledge the match without waking the agent, or
 * `{ auth }` to dispatch. `context` strings are added before the turn.
 */
export type BoardInboundResult = {
  readonly auth: SessionAuthContext | null;
  readonly context?: readonly string[];
  readonly title?: string;
} | null;

/**
 * Target accepted by `to(board, target)` for proactive sessions. `watcher` picks whose session
 * the thread is, when the channel has several; it defaults to the only watcher, or the profile.
 */
export type BoardReceiveTarget = { readonly watcher?: string } &
  /** Continues an existing thread, by any message ID in it. */
  (
    | { readonly thread: string }
    | {
        readonly channel: string;
        readonly text: string;
        readonly labels?: Readonly<Record<string, string>>;
      }
  );

/** One watcher: what wakes the agent for one task, and what that task's turns start with. */
export interface BoardWatcher {
  /** What you'd type after `vb tail`, such as `"dev --label kind=bug"`. */
  readonly tail: string;
  /** Added before every turn this watcher starts, such as the task's instructions. */
  readonly context?: readonly string[];
}

export type { BoardHeldClaim, BoardWorker };

type BoardEventHandler<T extends SessionEvent["type"]> = (
  event: ChannelEventOf<T>,
  ctx: ChannelEventContext<BoardEventContext>,
) => void | Promise<void>;

/** Event handlers supported by `boardChannel({ events })`. */
export interface BoardChannelEvents {
  /** Runs once per committed line; eve's default shows the request a reply answers now. */
  readonly committed?: (
    line: CommittedLine,
    ctx: ChannelEventContext<BoardEventContext>,
  ) => void | Promise<void>;
  readonly "turn.started"?: BoardEventHandler<"turn.started">;
  readonly "call.requested"?: BoardEventHandler<"call.requested">;
  readonly "call.settled"?: BoardEventHandler<"call.settled">;
  readonly "content.completed"?: BoardEventHandler<"content.completed">;
  readonly "interaction.opened"?: BoardEventHandler<"interaction.opened">;
  readonly "interaction.settled"?: BoardEventHandler<"interaction.settled">;
  readonly "turn.settled"?: BoardEventHandler<"turn.settled">;
  readonly "session.ended"?: BoardEventHandler<"session.ended">;
}

/** Configuration for {@link boardChannel}. */
export interface BoardChannelConfig {
  /**
   * Which of the team's boards, by name, such as `"security"`. Defaults to the team's default
   * board, named General, or to the board at `BOARD_URL`.
   */
  readonly name?: string;
  /** Another team's board, by the team's ID (`team_…`) or slug. Defaults to the deployment's team. */
  readonly team?: string;
  /**
   * What wakes the agent: what you'd type after `vb tail`, such as `"dev --mentions @eve"`. It's
   * one watcher named after the profile. Without it, `watchers`, or `worker`, the channel registers
   * nothing, and only proactive sessions use it.
   */
  readonly tail?: string;
  /**
   * Several watchers, by name, instead of `tail`: one per task, up to 32. Each thread a watcher
   * matches gets a session of that watcher's own, and the session's auth carries the watcher's
   * name as the `watcher` attribute, for instructions and hooks to read. Names follow the same
   * rule as `profile`.
   */
  readonly watchers?: Readonly<Record<string, BoardWatcher>>;
  /**
   * Claims ready tasks from the board's queue. Every wake-up claims up to `concurrency` tasks,
   * and each claimed task's thread becomes a session that holds the claim until the agent settles it.
   */
  readonly worker?: BoardWorker;
  /**
   * The profile eve writes as, under its verified principal: a letter, then up to 31 letters,
   * numbers, or hyphens. The agent's own posts as this profile never wake it. Defaults to
   * `"eve"`.
   */
  readonly profile?: string;
  /** Also register from preview deployments. All previews share one registration. */
  readonly previews?: boolean;
  readonly events?: BoardChannelEvents;
  readonly turnPolicy?: TurnPolicy;
  /** Size and media-type limits for attachments eve downloads from the board. */
  readonly uploadPolicy?: UploadPolicyInput;
  /** Decides whether a matched post wakes the agent. Defaults to dispatching every matched post. */
  onMessage?(
    message: BoardMessage,
    ctx: BoardMessageContext,
  ): BoardInboundResult | Promise<BoardInboundResult>;
}

/** The settings a mounted extension binds after its modules load, so the channel reads them late. */
export type BoardChannelSettings = Pick<
  BoardChannelConfig,
  "name" | "team" | "tail" | "watchers" | "worker" | "profile" | "previews"
>;

/** Concrete return type of {@link boardChannel}. */
export interface BoardChannel extends Channel<BoardChannelState, BoardReceiveTarget> {}

export interface BoardSettings {
  readonly target: BoardTarget;
  readonly watcher: BoardWatcherConfig | undefined;
  readonly contexts: Readonly<Record<string, readonly string[]>>;
  readonly worker: ResolvedBoardWorker | undefined;
}

/**
 * A channel for Vercel Board: the board wakes the agent when a post matches `tail`, each board
 * thread is a session, and the agent's replies, reactions, and typing go back to the thread, and
 * from there to whatever Slack, GitHub, or Linear thread the board syncs. With `worker`, it also
 * claims ready tasks, and each claimed task's thread is a session that holds the claim.
 */
export function boardChannel(config: BoardChannelConfig = {}): BoardChannel {
  return createBoardChannel(config, () => config);
}

export function createBoardChannel(
  config: BoardChannelConfig,
  settingsOf: () => BoardChannelSettings,
): BoardChannel {
  const settings = (): BoardSettings => resolveBoardSettings(settingsOf());
  const client = () => createBoardClient(settings().target);

  const keepClaim = async (state: BoardChannelState) => {
    const claim = state.task;
    if (claim == null || !claimDue(claim)) return;
    try {
      state.task = await renewClaim(client(), claim);
    } catch (error) {
      logError(log, "board task renewal failed", error, { task: claim.id });
    }
  };

  const endClaim = async (state: BoardChannelState, outcome: string) => {
    const claim = state.task;
    if (claim == null) return;
    state.task = null;
    try {
      await holdUnsettled(client(), claim, outcome);
    } catch (error) {
      logError(log, "board task hold failed", error, { task: claim.id });
    }
  };

  const chosen: BoardChannelEvents = { ...createDefaultEvents(), ...config.events };

  const channel = defineChannel<BoardChannelState, BoardChannelContext, BoardReceiveTarget>({
    turnPolicy: config.turnPolicy,
    state: initialState(),

    context(state) {
      return { board: threadHandle(client(), state.threadId ?? "", state), state };
    },

    metadata(state) {
      return {
        boardChannel: state.channel,
        boardTask: state.task ?? null,
        boardThread: state.threadId,
        boardWatcher: state.watcher ?? null,
      };
    },

    deliver(payload, ctx) {
      if (payload.state?.messageId != null) ctx.state.messageId = payload.state.messageId;
      if (payload.state?.task !== undefined) ctx.state.task = payload.state.task;
    },

    routes: [
      POST<BoardChannelState>(BOARD_WAKE_ROUTE, async (request, { from, waitUntil }) => {
        const resolved = settings();
        const { watcher } = resolved;
        if (watcher === undefined) return Response.json({ ignored: true, ok: true });
        const poll =
          hostedEnvironment() === undefined && request.headers.get(BOARD_POLL_HEADER) === "1";
        const wake = drainMatches({
          client: client(),
          config,
          from,
          overwrite: poll || reachedOnWakeHost(request),
          poll,
          settings: { ...resolved, watcher },
        });
        if (!poll) {
          waitUntil(wake.catch((error) => logError(log, "board wake-up failed", error)));
          return Response.json({ ok: true }, { status: 202 });
        }
        try {
          return Response.json({ dispatched: await wake, ok: true });
        } catch (error) {
          const errorId = logError(log, "board pull failed", error);
          return Response.json(
            { error: "Board pull failed.", errorId, ok: false },
            { status: 502 },
          );
        }
      }),
    ],

    async receive({ message, target, ...send }, { from }) {
      const resolved = settings();
      const board = client();
      let root: BoardMessage;
      if ("thread" in target && typeof target.thread === "string") {
        root = (await board.thread(target.thread)).message;
      } else if ("channel" in target && typeof target.channel === "string") {
        if (typeof target.text !== "string" || target.text.length === 0) {
          throw new Error(
            "boardChannel().receive needs target.text to start a thread in a channel.",
          );
        }
        root = await board.post(target.channel, { labels: target.labels, text: target.text });
      } else {
        throw new Error(
          "boardChannel().receive needs target.thread, or target.channel and target.text.",
        );
      }
      const watchers = Object.keys(resolved.watcher?.watchers ?? {}).filter(
        (name) => name !== BOARD_WORKER_WATCHER,
      );
      const watcher =
        target.watcher ?? (watchers.length === 1 ? watchers[0]! : resolved.target.profile);
      return sendRecovering(from(boardSessionAddress(watcher, root)), message, {
        ...send,
        state: { channel: root.channel, messageId: root.id, threadId: root.id, watcher },
      });
    },

    fetchFile(url) {
      const policy = mergeUploadPolicy(config.uploadPolicy);
      if (policy === "disabled") return Promise.resolve(null);
      return fetchBoardAttachment(url, client(), policy.maxBytes);
    },
    uploadPolicy: config.uploadPolicy,

    events: {
      ...chosen,
      async "turn.started"(event, ctx) {
        await keepClaim(ctx.channel.state);
        await chosen["turn.started"]?.(event, ctx);
      },
      async "call.requested"(event, ctx) {
        await keepClaim(ctx.channel.state);
        await chosen["call.requested"]?.(event, ctx);
      },
      async "call.settled"(event, ctx) {
        const { state } = ctx.channel;
        if (
          state.task != null &&
          event.data.outcome === "completed" &&
          taskSettlementOf(event.data.output)?.task === state.task.id
        ) {
          state.task = null;
        } else {
          await keepClaim(state);
        }
        await chosen["call.settled"]?.(event, ctx);
      },
      async "turn.settled"(event, ctx) {
        await chosen["turn.settled"]?.(event, ctx);
        await endClaim(ctx.channel.state, event.data.outcome);
      },
      async "session.ended"(event, ctx) {
        await chosen["session.ended"]?.(event, ctx);
        await endClaim(ctx.channel.state, "ended");
      },
    },
  });

  setChannelStartHook(channel, ({ request, waitUntil }) => {
    const resolved = settings();
    if (resolved.watcher === undefined) return;
    waitUntil(
      reconcileRegistration({
        client: client(),
        overwrite: hostedEnvironment() === "preview",
        watcher: resolved.watcher,
      }).catch((error) => logError(log, "board registration failed", error)),
    );
    if (hostedEnvironment() === undefined) {
      startLocalPoller(
        `${new URL(request.url).origin}${publicBoardRoute(BOARD_WAKE_ROUTE)}`,
        resolved,
      );
    }
  });

  return channel;
}

export function resolveBoardTarget(
  config: Pick<BoardChannelSettings, "name" | "team" | "profile">,
): BoardTarget {
  const profile = config.profile ?? DEFAULT_BOARD_PROFILE;
  if (!BOARD_PROFILE_PATTERN.test(profile)) {
    throw new Error(
      `Board profile "${profile}" is invalid: use a letter, then up to 31 letters, numbers, or hyphens.`,
    );
  }
  return {
    profile,
    ...(config.name !== undefined && { name: config.name }),
    ...(config.team !== undefined && { team: config.team }),
  };
}

export function resolveBoardSettings(config: BoardChannelSettings): BoardSettings {
  const target = resolveBoardTarget(config);
  const tail = config.tail?.trim();
  if (tail && config.watchers !== undefined) {
    throw new Error("Pass the board channel either `tail` or `watchers`, not both.");
  }
  const watchers: Record<string, BoardWatcher> = tail
    ? { [target.profile]: { tail } }
    : { ...config.watchers };
  for (const name of Object.keys(watchers)) {
    if (!BOARD_PROFILE_PATTERN.test(name)) {
      throw new Error(
        `Board watcher "${name}" is invalid: use a letter, then up to 31 letters, numbers, or hyphens.`,
      );
    }
  }
  const worker = config.worker === undefined ? undefined : resolveBoardWorker(config.worker);
  if (worker !== undefined) {
    if (watchers[BOARD_WORKER_WATCHER] !== undefined) {
      throw new Error(
        `Board watcher "${BOARD_WORKER_WATCHER}" is taken by the worker: rename the watcher.`,
      );
    }
    watchers[BOARD_WORKER_WATCHER] = { context: worker.context, tail: worker.tail };
  }
  const names = Object.keys(watchers);
  if (names.length > MAX_WATCHERS) {
    throw new Error(
      `A board registration holds at most ${MAX_WATCHERS} watchers; got ${names.length}.`,
    );
  }
  return {
    contexts: Object.fromEntries(names.map((name) => [name, watchers[name]!.context ?? []])),
    target,
    watcher:
      names.length === 0
        ? undefined
        : {
            previews: config.previews === true,
            watchers: Object.fromEntries(
              names.map((name) => [name, { tail: watchers[name]!.tail }]),
            ),
          },
    worker,
  };
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

const reconciledLocally = new Set<string>();

interface DrainInput {
  readonly client: BoardClient;
  readonly config: BoardChannelConfig;
  readonly from: ChannelFrom<BoardChannelState>;
  readonly overwrite: boolean;
  readonly poll: boolean;
  readonly settings: BoardSettings & { readonly watcher: BoardWatcherConfig };
}

async function drainMatches(input: DrainInput): Promise<number> {
  const { client, poll, settings } = input;
  const key = JSON.stringify([
    process.env.BOARD_URL?.trim() || null,
    settings.target,
    settings.watcher,
  ]);
  if (!poll || !reconciledLocally.has(key)) {
    try {
      await reconcileRegistration({
        client,
        overwrite: input.overwrite,
        watcher: settings.watcher,
      });
      if (poll) reconciledLocally.add(key);
    } catch (error) {
      if (poll) throw error;
      logError(log, "board registration failed", error);
    }
  }

  const self = await client.me();
  let dispatched = 0;
  for (let pull = 0; pull < MAX_PULLS_PER_WAKE; pull += 1) {
    let matches: readonly BoardMatch[];
    try {
      matches = await client.matches({
        limit: MATCHES_PER_PULL,
        wait: poll ? POLL_WAIT_SECONDS : 0,
      });
    } catch (error) {
      reconciledLocally.delete(key);
      throw error;
    }
    for (const match of matches) {
      if (await handleMatch({ ...input, match, self })) dispatched += 1;
    }
    if (poll || matches.length === 0) break;
  }

  const { worker } = settings;
  if (worker !== undefined) {
    try {
      dispatched += await dispatchWork({
        client,
        deliver: (claim) => deliverClaim(input, worker, claim),
        self,
        worker,
      });
    } catch (error) {
      logError(log, "board task dispatch failed", error);
    }
  }
  return dispatched;
}

async function deliverClaim(
  input: DrainInput,
  worker: ResolvedBoardWorker,
  claim: BoardClaimedTask,
): Promise<void> {
  const { task } = claim;
  const board = { name: input.settings.target.name, watcher: BOARD_WORKER_WATCHER };
  await sendRecovering(
    input.from(boardSessionAddress(BOARD_WORKER_WATCHER, task)),
    boardMessageContent(task),
    {
      auth: defaultBoardAuth(task, board),
      context: [formatTaskContext(claim), ...worker.context],
      idempotencyKey: `board:task:${claim.taskId}:${claim.epoch}`,
      state: {
        channel: task.channel,
        messageId: task.id,
        task: heldClaimOf(claim, worker.lease),
        threadId: task.id,
        watcher: BOARD_WORKER_WATCHER,
      },
    },
  );
}

async function handleMatch(
  input: DrainInput & {
    readonly match: BoardMatch;
    readonly self: { readonly principal: string; readonly actor: string };
  },
): Promise<boolean> {
  const { client, match } = input;
  try {
    const dispatched =
      match.watcher === BOARD_WORKER_WATCHER
        ? await handleWorkerMatch(input)
        : await handleWatcherMatch(input);
    await client.ack(match);
    return dispatched;
  } catch (error) {
    const errorId = logError(log, "board match failed", error, { match: match.id });
    await client
      .ack(match, { error: `eve couldn't dispatch this match (error id ${errorId})` })
      .catch((ackError) => logError(log, "board ack failed", ackError, { match: match.id }));
    return false;
  }
}

function postedByOthers(
  message: BoardMessage | undefined,
  input: { readonly client: BoardClient; readonly self: { readonly principal: string } },
): message is BoardMessage {
  if (message === undefined || message.deleted) return false;
  return !(
    message.by.principal === input.self.principal &&
    message.by.profile === input.client.profile &&
    message.schedule === undefined
  );
}

async function handleWatcherMatch(
  input: DrainInput & {
    readonly match: BoardMatch;
    readonly self: { readonly principal: string };
  },
): Promise<boolean> {
  const { client, match, settings } = input;
  const message = match.event.message;
  if (match.event.type !== "message.posted" || !postedByOthers(message, input)) return false;
  const threadId = boardThreadId(message);
  const board = { name: settings.target.name, watcher: match.watcher };
  const onMessage =
    input.config.onMessage ??
    ((posted: BoardMessage): BoardInboundResult => ({ auth: defaultBoardAuth(posted, board) }));
  const result = await onMessage(message, {
    board: threadHandle(client, threadId, { messageId: message.id }),
    name: settings.target.name,
    watcher: match.watcher,
  });
  if (result === null) return false;
  await sendRecovering(
    input.from(boardSessionAddress(match.watcher, message)),
    boardMessageContent(message),
    {
      auth: result.auth,
      context: [
        formatBoardContext(message),
        ...(settings.contexts[match.watcher] ?? []),
        ...(result.context ?? []),
      ],
      idempotencyKey: `board:${match.id}`,
      state: { channel: message.channel, messageId: message.id, threadId, watcher: match.watcher },
      title: result.title,
    },
  );
  return true;
}

async function handleWorkerMatch(
  input: DrainInput & {
    readonly match: BoardMatch;
    readonly self: { readonly principal: string; readonly actor: string };
  },
): Promise<boolean> {
  const { client, match, settings } = input;
  const message = match.event.message;
  if (
    match.event.type !== "message.posted" ||
    !postedByOthers(message, input) ||
    message.re === null
  ) {
    return false;
  }
  const claim = (await client.thread(message.re)).message.task?.claim;
  if (claim?.actor !== input.self.actor || Date.parse(claim.until) <= Date.now()) return false;
  const board = { name: settings.target.name, watcher: BOARD_WORKER_WATCHER };
  await sendRecovering(
    input.from(boardSessionAddress(BOARD_WORKER_WATCHER, message)),
    boardMessageContent(message),
    {
      auth: defaultBoardAuth(message, board),
      context: [formatTaskFollowUpContext(message), ...(settings.worker?.context ?? [])],
      idempotencyKey: `board:${match.id}`,
      state: {
        channel: message.channel,
        messageId: message.id,
        threadId: message.re,
        watcher: BOARD_WORKER_WATCHER,
      },
    },
  );
  return true;
}

function threadHandle(
  client: BoardClient,
  threadId: string,
  state: { readonly messageId: string | null },
): BoardThreadHandle {
  return {
    threadId,
    reply: (post) => client.reply(threadId, typeof post === "string" ? { text: post } : post),
    async react(emoji, options = {}) {
      const target = options.messageId ?? state.messageId ?? threadId;
      await client.react(target, emoji, { remove: options.remove });
    },
    typing: (status) => client.typing(threadId, status),
    label: (change) => client.label(threadId, change),
    read: () => client.thread(threadId),
  };
}

function createDefaultEvents(): BoardChannelEvents {
  const surface = surfaceEvents<BoardEventContext>({
    post: postChunks,
    restart: "thread",
    requests: { showOne: showPrompt },
    signIns: boardSignIns,
    typing: async (channel) => {
      await bestEffort("typing", () => channel.board.typing());
    },
  });
  return {
    ...surface,
    async "content.completed"(event, ctx) {
      if (ctx.channel.state.watcher === BOARD_WORKER_WATCHER) return;
      await surface["content.completed"](event, ctx);
    },
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
    logError(log, `board ${what} failed — swallowed`, error);
  }
}

function initialState(): BoardChannelState {
  return { channel: null, messageId: null, task: null, threadId: null };
}

const POLLERS = Symbol.for("eve.board.pollers");
type PollerGlobal = typeof globalThis & { [POLLERS]?: Map<string, AbortController> };

function startLocalPoller(wakeUrl: string, settings: BoardSettings): void {
  const pollers = ((globalThis as PollerGlobal)[POLLERS] ??= new Map());
  const key = JSON.stringify(settings.target);
  pollers.get(key)?.abort();
  const controller = new AbortController();
  pollers.set(key, controller);
  void pollLoop(wakeUrl, controller.signal);
}

async function pollLoop(wakeUrl: string, signal: AbortSignal): Promise<void> {
  let failures = 0;
  while (!signal.aborted) {
    try {
      const response = await fetch(wakeUrl, {
        headers: { [BOARD_POLL_HEADER]: "1" },
        method: "POST",
        signal,
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`the wake route answered ${response.status}`);
      failures = 0;
    } catch (error) {
      if (signal.aborted) return;
      failures += 1;
      if (failures === 1) log.warn("board pull failed; retrying with backoff", { error });
      await sleep(Math.min(30_000, 1_000 * 2 ** failures), signal);
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
