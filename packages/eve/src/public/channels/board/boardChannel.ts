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
  type BoardApiOptions,
  type BoardClient,
  type BoardCredentials,
  type BoardMatch,
  type BoardMessage,
  type BoardPostOptions,
  type BoardThread,
} from "#public/channels/board/client.js";
import {
  boardMessageContent,
  boardSessionAddress,
  boardThreadId,
  defaultBoardAuth,
  fetchBoardAttachment,
  formatBoardContext,
} from "#public/channels/board/inbound.js";
import {
  BOARD_WAKE_ROUTE,
  hostedEnvironment,
  publicBoardRoute,
  reachedOnWakeHost,
  reconcileRegistration,
  type BoardWatcherConfig,
} from "#public/channels/board/registration.js";
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

/** The profile eve writes as when none is configured. */
export const DEFAULT_BOARD_PROFILE = "eve";
/** A board message holds at most 10,000 characters. */
export const BOARD_TEXT_LIMIT = 10_000;
/** A board profile: a letter, then up to 31 letters, numbers, or hyphens. */
export const BOARD_PROFILE_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,31}$/u;
/** Marks the local poller's own requests, which hold the route open while the board long-polls. */
const BOARD_POLL_HEADER = "x-eve-board-poll";
/** Pulls per wake-up: a burst of matches wakes the deployment once, and it drains them. */
const MAX_PULLS_PER_WAKE = 20;
const MATCHES_PER_PULL = 10;
/** Seconds the board holds a local pull open waiting for a match; its maximum is 25. */
const POLL_WAIT_SECONDS = 25;

/** JSON-serializable state for one board thread's session. */
export interface BoardChannelState extends PromptQueueState {
  readonly url: string | null;
  readonly channel: string | null;
  /** The thread's root message ID, which replies name. */
  readonly threadId: string | null;
  /** The watcher whose match started the session. */
  readonly watcher?: string | null;
  /** The message the current turn answers, which gets the `eyes` reaction. */
  messageId: string | null;
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
  /** The board's URL. */
  readonly url: string;
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
    /** Starts a thread in `channel` with `text`, as the configured profile; the session owns it. */
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
  /** `"enters"` wakes the agent only when a thread comes into view. Defaults to `"matches"`. */
  readonly when?: "matches" | "enters";
  /** Added before every turn this watcher starts, such as the task's instructions. */
  readonly context?: readonly string[];
}

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
  /** The board's full URL, as its discovery returns it. Defaults to `BOARD_URL`. */
  readonly url?: string;
  /**
   * What wakes the agent: what you'd type after `vb tail`, such as `"dev --mentions @eve"`. It's
   * one watcher named after the profile. Without it or `watchers` the channel registers nothing,
   * and only proactive sessions use it.
   */
  readonly tail?: string;
  /** `"enters"` wakes the agent only when a thread comes into view. Defaults to `"matches"`. */
  readonly when?: "matches" | "enters";
  /**
   * Several watchers, by name, instead of `tail`: one per task, up to 32. Each thread a watcher
   * matches gets a session of that watcher's own, and the session's auth carries the watcher's
   * name as the `watcher` attribute, for instructions and hooks to read. Names follow the same
   * rule as `profile`.
   */
  readonly watchers?: Readonly<Record<string, BoardWatcher>>;
  /**
   * The profile eve writes as, under its verified principal: a letter, then up to 31 letters,
   * numbers, or hyphens. The agent's own posts as this profile never wake it. Defaults to
   * `"eve"`.
   */
  readonly profile?: string;
  /** Also register from preview deployments. All previews share one registration. */
  readonly previews?: boolean;
  readonly api?: BoardApiOptions;
  readonly credentials?: BoardCredentials;
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
  "url" | "tail" | "when" | "watchers" | "profile" | "previews"
>;

/** Concrete return type of {@link boardChannel}. */
export interface BoardChannel extends Channel<BoardChannelState, BoardReceiveTarget> {}

export interface BoardSettings {
  readonly url: string;
  readonly profile: string;
  /** What eve registers, or `undefined` with no watchers. */
  readonly watcher: BoardWatcherConfig | undefined;
  /** Each watcher's turn context, by name. */
  readonly contexts: Readonly<Record<string, readonly string[]>>;
}

/** The board allows at most 32 watchers per registration. */
const MAX_WATCHERS = 32;

/**
 * A channel for `@vercel/board`: the board wakes the agent when a post matches `tail`, each
 * board thread is a session, and the agent's replies, reactions, and typing go back to the
 * thread, and from there to whatever Slack, GitHub, or Linear thread the board syncs.
 */
export function boardChannel(config: BoardChannelConfig = {}): BoardChannel {
  return createBoardChannel(config, () => config);
}

/**
 * {@link boardChannel} whose {@link BoardChannelSettings} are read when first used, for a
 * mounted extension whose config is bound after its modules load.
 */
export function createBoardChannel(
  config: BoardChannelConfig,
  settingsOf: () => BoardChannelSettings,
): BoardChannel {
  const settings = (): BoardSettings => resolveBoardSettings(settingsOf());
  const client = (session?: string) => {
    const { profile, url } = settings();
    return createBoardClient({
      api: config.api,
      credentials: config.credentials,
      profile,
      session,
      url,
    });
  };

  const channel = defineChannel<BoardChannelState, BoardChannelContext, BoardReceiveTarget>({
    turnPolicy: config.turnPolicy,
    state: initialState(),

    context(state, session) {
      return {
        board: threadHandle(client(session.session.id), state.threadId ?? "", state),
        state,
      };
    },

    deliver(payload, ctx) {
      if (payload.state?.messageId != null) ctx.state.messageId = payload.state.messageId;
    },

    routes: [
      POST<BoardChannelState>(BOARD_WAKE_ROUTE, async (request, { from, waitUntil }) => {
        const resolved = settings();
        if (resolved.watcher === undefined) return Response.json({ ignored: true, ok: true });
        const poll =
          hostedEnvironment() === undefined && request.headers.get(BOARD_POLL_HEADER) === "1";
        const wake = drainMatches({
          client: client(),
          config,
          contexts: resolved.contexts,
          from,
          profile: resolved.profile,
          // A forged wake-up on an older deployment's own URL must not put its old tail back.
          overwrite: poll || reachedOnWakeHost(request),
          poll,
          watcher: resolved.watcher,
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
      const watchers = Object.keys(resolved.watcher?.watchers ?? {});
      const watcher = target.watcher ?? (watchers.length === 1 ? watchers[0]! : resolved.profile);
      return sendRecovering(from(boardSessionAddress(watcher, root)), message, {
        ...send,
        state: {
          channel: root.channel,
          messageId: root.id,
          threadId: root.id,
          url: board.url,
          watcher,
        },
      });
    },

    fetchFile(url) {
      const policy = mergeUploadPolicy(config.uploadPolicy);
      if (policy === "disabled") return Promise.resolve(null);
      return fetchBoardAttachment(url, client(), policy.maxBytes);
    },
    uploadPolicy: config.uploadPolicy,

    events: { ...createDefaultEvents(), ...config.events },
  });

  setChannelStartHook(channel, ({ request, waitUntil }) => {
    const resolved = settings();
    if (resolved.watcher === undefined) return;
    waitUntil(
      reconcileRegistration({
        client: client(),
        // Previews share one registration, so the latest preview to start takes it.
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

/** The board and profile the channel and tools act as, with `BOARD_URL` and `"eve"` as defaults. */
export function resolveBoardSettings(config: BoardChannelSettings): BoardSettings {
  const url = (config.url ?? process.env.BOARD_URL)?.trim().replace(/\/+$/u, "");
  if (!url) {
    throw new Error(
      "eve needs the board's URL: set BOARD_URL, or pass `url` to the board channel or extension, such as https://team.example/api/board.",
    );
  }
  const profile = config.profile ?? DEFAULT_BOARD_PROFILE;
  if (!BOARD_PROFILE_PATTERN.test(profile)) {
    throw new Error(
      `Board profile "${profile}" is invalid: use a letter, then up to 31 letters, numbers, or hyphens.`,
    );
  }
  const tail = config.tail?.trim();
  if (tail && config.watchers !== undefined) {
    throw new Error("Pass the board channel either `tail` or `watchers`, not both.");
  }
  const watchers: Record<string, BoardWatcher> = tail
    ? { [profile]: { tail, when: config.when } }
    : { ...config.watchers };
  const names = Object.keys(watchers);
  if (names.length > MAX_WATCHERS) {
    throw new Error(
      `A board registration holds at most ${MAX_WATCHERS} watchers; got ${names.length}.`,
    );
  }
  for (const name of names) {
    if (!BOARD_PROFILE_PATTERN.test(name)) {
      throw new Error(
        `Board watcher "${name}" is invalid: use a letter, then up to 31 letters, numbers, or hyphens.`,
      );
    }
  }
  return {
    contexts: Object.fromEntries(names.map((name) => [name, watchers[name]!.context ?? []])),
    profile,
    url,
    watcher:
      names.length === 0
        ? undefined
        : {
            previews: config.previews === true,
            watchers: Object.fromEntries(
              names.map((name) => [
                name,
                { tail: watchers[name]!.tail, when: watchers[name]!.when ?? "matches" },
              ]),
            ),
          },
  };
}

/**
 * Sends to a thread's session, replacing a session another eve version built: it can never run
 * again, so the thread starts over in a fresh session instead of failing every delivery.
 */
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
    await source.reset({ reason: "Stranded by an eve upgrade; the board thread starts over." });
    return await source.send(message, options);
  }
}

// Local pulls reconcile once per process; a hosted wake-up checks every time.
const reconciledLocally = new Set<string>();

async function drainMatches(input: {
  readonly client: BoardClient;
  readonly config: BoardChannelConfig;
  readonly contexts: Readonly<Record<string, readonly string[]>>;
  readonly from: ChannelFrom<BoardChannelState>;
  readonly profile: string;
  readonly overwrite: boolean;
  readonly poll: boolean;
  readonly watcher: BoardWatcherConfig;
}): Promise<number> {
  const { client, poll } = input;
  const key = `${client.url}\n${JSON.stringify(input.watcher)}`;
  if (!poll || !reconciledLocally.has(key)) {
    try {
      await reconcileRegistration({ client, overwrite: input.overwrite, watcher: input.watcher });
      if (poll) reconciledLocally.add(key);
    } catch (error) {
      if (poll) throw error;
      logError(log, "board registration failed", error);
    }
  }

  // The board skips a write only for the watcher named after the writer's profile, so with
  // several watchers eve skips its own posts itself.
  const self = (await client.me()).principal;
  let dispatched = 0;
  for (let pull = 0; pull < MAX_PULLS_PER_WAKE; pull += 1) {
    const matches = await client.matches({
      limit: MATCHES_PER_PULL,
      wait: poll ? POLL_WAIT_SECONDS : 0,
    });
    for (const match of matches) {
      if (await handleMatch({ ...input, match, self })) dispatched += 1;
    }
    if (poll || matches.length === 0) break;
  }
  return dispatched;
}

async function handleMatch(input: {
  readonly client: BoardClient;
  readonly config: BoardChannelConfig;
  readonly contexts: Readonly<Record<string, readonly string[]>>;
  readonly from: ChannelFrom<BoardChannelState>;
  readonly match: BoardMatch;
  readonly profile: string;
  /** This deployment's principal on the board. */
  readonly self: string;
}): Promise<boolean> {
  const { client, match } = input;
  const message = match.event.message;
  try {
    let dispatched = false;
    if (
      match.event.type === "message.posted" &&
      message !== undefined &&
      !message.deleted &&
      !postedBySelf(message, input)
    ) {
      const threadId = boardThreadId(message);
      const board = { url: client.url, watcher: match.watcher };
      const onMessage =
        input.config.onMessage ??
        ((posted: BoardMessage): BoardInboundResult => ({ auth: defaultBoardAuth(posted, board) }));
      const result = await onMessage(message, {
        board: threadHandle(client, threadId, { messageId: message.id }),
        url: client.url,
        watcher: match.watcher,
      });
      if (result !== null) {
        const source = input.from(boardSessionAddress(match.watcher, message));
        await sendRecovering(source, boardMessageContent(message, board), {
          auth: result.auth,
          context: [
            formatBoardContext(message, board),
            ...(input.contexts[match.watcher] ?? []),
            ...(result.context ?? []),
          ],
          idempotencyKey: `board:${match.id}`,
          state: {
            channel: message.channel,
            messageId: message.id,
            threadId,
            url: client.url,
            watcher: match.watcher,
          },
          title: result.title,
        });
        dispatched = true;
      }
    }
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

/** The agent's own post, unless a schedule posted it: a reminder to itself should wake it. */
function postedBySelf(
  message: BoardMessage,
  input: { readonly profile: string; readonly self: string },
): boolean {
  return (
    message.by.principal === input.self &&
    message.by.profile === input.profile &&
    message.schedule === undefined
  );
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
    // A reply can only answer the prompt it sees, so prompts post one at a time.
    requests: { showOne: showPrompt },
    signIns: boardSignIns,
    typing: async (channel) => {
      await bestEffort("typing", () => channel.board.typing());
    },
  });
  return {
    ...surface,
    async "turn.started"(event, ctx) {
      await bestEffort("reaction", () => ctx.channel.board.react("eyes"));
      await surface["turn.started"]?.(event, ctx);
    },
  };
}

async function showPrompt(channel: BoardEventContext, request: Interaction): Promise<void> {
  const body = renderTextInteraction(request.request);
  const freeform =
    request.request.allowFreeform === true ? "\n\nYou can also reply with a custom answer." : "";
  await postChunks(channel, `${body}${freeform}\n\nReply in this thread to answer.`);
}

/**
 * A board thread as a sign-in shows on it: threads are shared and may sync to a Slack channel,
 * so it never posts the link, only a status saying where to connect.
 */
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

/** Splits text into board-sized messages, preferring line breaks. */
export function splitBoardText(text: string, limit = BOARD_TEXT_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const cut = rest.lastIndexOf("\n", limit);
    let end = cut > limit / 2 ? cut : limit;
    // Never split a surrogate pair, such as an emoji, across two messages.
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
  return { channel: null, messageId: null, threadId: null, url: null };
}

// One poller per board and profile per process: a reloaded dev runtime replaces the old one.
const POLLERS = Symbol.for("eve.board.pollers");
type PollerGlobal = typeof globalThis & { [POLLERS]?: Map<string, AbortController> };

/**
 * Outside a hosted deployment nothing can wake eve, so it pulls: it calls its own wake route,
 * which holds each pull open on the board until a match arrives.
 */
function startLocalPoller(wakeUrl: string, settings: BoardSettings): void {
  const pollers = ((globalThis as PollerGlobal)[POLLERS] ??= new Map());
  const key = `${settings.url}\n${settings.profile}`;
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
    // The poller must never be what keeps a process alive.
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
