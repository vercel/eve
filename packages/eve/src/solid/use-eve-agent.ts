import type { Delivery } from "#shared/delivery.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { createMemo, createSignal, getOwner, onCleanup, onSettled, type Accessor } from "solid-js";
import type { MessageContent } from "#shared/message-content.js";

import {
  attachSessionStore,
  detachSessionStore,
  SessionStore,
  type SessionStoreCallbacks,
  type SessionStoreInit,
  type SessionStoreSnapshot,
  type SessionStoreStatus,
  type PrepareSend,
} from "#client/session-store.js";
import { resolveEveAgentBaseUrl } from "#client/agent-base-url.js";
import type { ClientSession } from "#client/session.js";
import type {
  ClientAuth,
  HeadersValue,
  RespondTurnOptions,
  SendTurnOptions,
  ClientSessionState,
} from "#client/types.js";

export type { PrepareSend };

/**
 * Outstanding work this binding has observed or still owes. Failures are reported separately in
 * `error`.
 *
 * - `"idle"`: no command, answer, or followed receipt is pending, and the last observed view is
 *   idle. A turn waiting only on a person can still be open; read `activeTurn(view)`.
 * - `"resuming"`: catching up on an attached session; submission is disabled.
 * - `"busy"`: a send, answer, or control command is pending, a followed receipt has not settled,
 *   or the session has running or queued work.
 *
 * After `followWhile` closes the stream, `status` reflects the last observed view, not the
 * current server state.
 */
export type UseEveAgentStatus = SessionStoreStatus;

/**
 * Point-in-time projected state for an eve agent session: the conversation (`messages`,
 * `agents`, `view`), `error`, `events`, `session`, and `status`.
 *
 * `useEveAgent` passes this shape to callbacks such as `onFinish`, but exposes
 * the same fields as individual Solid accessors on its return value.
 */
export type UseEveAgentSnapshot = SessionStoreSnapshot;

/**
 * Reactive return value from `useEveAgent`.
 *
 * The state fields are Solid accessors. Call them inside JSX, `createMemo`, or
 * `createEffect` and Solid tracks them as eve streams new events.
 */
export interface UseEveAgentReturn {
  /**
   * Request durable cancellation of the active turn while continuing to receive its events.
   * Offer it while `activeTurn(view())` returns a turn, including one waiting on a person.
   */
  readonly cancel: () => Promise<Delivery>;
  /** Rendered messages, local answers, native lifecycle tables, and followed agents. */
  readonly messages: Accessor<SessionStoreSnapshot["messages"]>;
  readonly agents: Accessor<SessionStoreSnapshot["agents"]>;
  /** Last transport-level error, or `undefined` when healthy. */
  readonly error: Accessor<Error | undefined>;
  readonly view: Accessor<SessionStoreSnapshot["view"]>;
  /** Raw server events from this session (authoritative stream). */
  readonly events: Accessor<readonly SessionStreamEvent[]>;
  /** Follow a same-session delivery receipt until settlement. */
  readonly follow: (receipt: Pick<Delivery, "sessionId" | "deliveryId">) => void;
  /** Resolves at the durable tail; subsequent following obeys `followWhile`. */
  readonly resume: () => Promise<void>;
  /** Create the session without starting its first turn. */
  readonly prewarm: () => Promise<void>;
  /** Clear all state and start a new session. */
  readonly newSession: () => void;
  /** Retires the server-side session; call newSession() to prepare a fresh conversation. */
  readonly end: () => Promise<Delivery>;
  readonly clear: () => Promise<Delivery>;
  readonly compact: () => Promise<Delivery>;
  /** Submits a message and resolves on acceptance, not execution. */
  readonly send: <TOutput = unknown>(
    message: MessageContent,
    options?: SendTurnOptions<TOutput>,
  ) => Promise<Delivery<TOutput>>;
  /** Submits answers and resolves on acceptance, not execution. */
  readonly respond: <TOutput = unknown>(
    answers: Parameters<ClientSession["respond"]>[0],
    options?: RespondTurnOptions<TOutput>,
  ) => Promise<Delivery<TOutput>>;
  /** Current session identity and stream cursor. */
  readonly session: Accessor<ClientSessionState | undefined>;
  /**
   * Outstanding work: `"idle"`, `"resuming"` (catching up on an attached session), or `"busy"`.
   * Read `activeTurn(view())` for turn openness. Failures are reported separately in `error`.
   */
  readonly status: Accessor<UseEveAgentStatus>;
}

/**
 * Configuration for a Solid eve agent session.
 *
 * Read once when `useEveAgent` creates its store; remount the component to
 * change the base URL or session. To rotate credentials or headers without
 * remounting, pass function values to `auth` or `headers`, which the client
 * resolves before each HTTP request.
 */
export interface UseEveAgentOptions extends SessionStoreCallbacks {
  /**
   * Named agent mounted by a framework integration such as `withEve({ agents })`.
   *
   * `agent: "support"` targets same-origin routes under
   * `/eve/support/v1/...`. Do not combine with `baseUrl`.
   */
  readonly agent?: string;
  /**
   * Credentials for the auto-created session. Pass function values to refresh
   * per request. Ignored when `session` is supplied.
   */
  readonly auth?: ClientAuth;
  /**
   * Custom headers for the auto-created session. Pass a function to resolve
   * fresh values per request. Ignored when `session` is supplied.
   */
  readonly headers?: HeadersValue;
  /**
   * Base URL for eve client requests. Do not combine with `agent`. Empty targets same-origin eve routes
   * such as `/eve/v1/...`; a same-origin prefix like `/api` routes through an
   * app-owned proxy; an absolute origin hits an eve server directly.
   *
   * @default ""
   */
  readonly baseUrl?: string;
  /** Ordered prefix of the session stream used to rehydrate projected state. */
  readonly initialEvents?: readonly SessionStreamEvent[];
  /** Seed session identity and stream cursor for resuming a prior conversation. */
  readonly initialSession?: ClientSessionState;
  /**
   * Project submitted user messages before eve confirms them with a
   * `delivery.consumed` fact. Such a message shows in `messages` only;
   * `events` stays the authoritative eve stream.
   *
   * @default true
   */
  readonly optimistic?: boolean;
  /** Recursively observe recorded children, or select relationships with a predicate, within store safety limits. @default false */
  readonly followAgents?: SessionStoreInit["followAgents"];
  /** Keep following while the committed view matches; local obligations take priority. @default () => true */
  readonly followWhile?: (view: SessionStoreSnapshot["view"]) => boolean;
  /** Create a session or prepare its existing idle owner on mount and after `newSession()`. @default false */
  readonly prewarm?: boolean;
  /** Replay the attached durable session after mount. Requires `initialSession` or `session`. */
  readonly resume?: boolean;
  /**
   * Pre-built client session to bind to. When omitted, the binding creates its
   * own session from `auth`, `headers`, and `baseUrl`.
   */
  readonly session?: ClientSession;
}

/**
 * Solid 2 primitive that drives one eve session and projects its event stream
 * into Solid accessors.
 *
 * Returns accessors for the conversation (`messages`, `agents`, `view`) and for `error`,
 * `events`, `session`, and `status`, plus `prewarm`, `send`, `respond`, `resume`, `cancel`,
 * `newSession`, and `end`. Call it inside a component or `createRoot()`; it throws without a
 * reactive owner. Configuration is read once; remount to change it. In the browser, the binding
 * connects once the component settles and disconnects when its owner is disposed. During server
 * rendering the accessors return the initial state and nothing connects.
 */
export function useEveAgent(options: UseEveAgentOptions = {}): UseEveAgentReturn {
  if (options.resume && options.initialSession === undefined && options.session === undefined) {
    throw new Error("useEveAgent({ resume: true }) requires initialSession or session.");
  }
  if (getOwner() === null) {
    throw new Error(
      "useEveAgent() must run inside a component or createRoot(). To share one conversation, create it inside createRoot() or a context provider.",
    );
  }
  const store = new SessionStore({
    auth: options.auth,
    headers: options.headers,
    baseUrl: resolveEveAgentBaseUrl({ agent: options.agent, baseUrl: options.baseUrl }),
    initialEvents: options.initialEvents,
    initialSession: options.initialSession,
    optimistic: options.optimistic,
    followAgents: options.followAgents,
    followWhile: (view) => options.followWhile?.(view) ?? true,
    prewarm: options.prewarm,
    session: options.session,
  });

  store.setCallbacks({
    onError: options.onError,
    onEvent: options.onEvent,
    onFinish: options.onFinish,
    onSessionChange: options.onSessionChange,
    prepareSend: options.prepareSend,
  });

  const [snapshot, setSnapshot] = createSignal(store.snapshot, { ownedWrite: true });
  const unsubscribe = store.subscribe(() => setSnapshot(store.snapshot));

  onCleanup(() => {
    unsubscribe();
    detachSessionStore(store);
  });
  onSettled(() => {
    attachSessionStore(store);
    if (options.resume) void store.resume().catch(() => {});
  });

  return {
    cancel: () => store.cancel(),
    follow: (receipt) => store.follow(receipt),
    messages: createMemo(() => snapshot().messages),
    agents: createMemo(() => snapshot().agents),
    view: createMemo(() => snapshot().view),
    error: createMemo(() => snapshot().error),
    events: createMemo(() => snapshot().events),
    prewarm: () => store.prewarm(),
    end: () => store.end(),
    newSession: () => store.newSession(),
    clear: () => store.clear(),
    compact: () => store.compact(),
    respond: <TOutput = unknown>(
      answers: Parameters<ClientSession["respond"]>[0],
      options?: RespondTurnOptions<TOutput>,
    ) => store.send({ ...options, answers }),
    resume: () => store.resume(),
    send: <TOutput = unknown>(message: MessageContent, options?: SendTurnOptions<TOutput>) =>
      store.send({ ...options, message }),
    session: createMemo(() => snapshot().session),
    status: createMemo(() => snapshot().status),
  };
}
