import type { Delivery } from "#shared/delivery.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { shallowRef, computed, onScopeDispose, type ComputedRef } from "vue";
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
 * the same fields as individual reactive refs on its return value.
 */
export type UseEveAgentSnapshot = SessionStoreSnapshot;

/**
 * Reactive return value from `useEveAgent`.
 */
export interface UseEveAgentReturn {
  /**
   * Request durable cancellation of the active turn while continuing to receive its events.
   * Offer it while `activeTurn(view)` returns a turn, including one waiting on a person.
   */
  readonly cancel: () => Promise<Delivery>;
  /** Rendered messages, local answers, native lifecycle tables, and followed agents. */
  readonly messages: ComputedRef<SessionStoreSnapshot["messages"]>;
  readonly agents: ComputedRef<SessionStoreSnapshot["agents"]>;
  /** Last transport-level error, or `undefined` when healthy. */
  readonly error: ComputedRef<Error | undefined>;
  readonly view: ComputedRef<SessionStoreSnapshot["view"]>;
  /** Raw server events from this session (authoritative stream). */
  readonly events: ComputedRef<readonly SessionStreamEvent[]>;
  /** Follow a same-session delivery receipt until settlement. */
  readonly follow: (receipt: Pick<Delivery, "sessionId" | "deliveryId">) => void;
  /** Resolves at the durable tail; subsequent following obeys `followWhile`. */
  readonly resume: () => Promise<void>;
  /** Create the session without starting its first turn. */
  readonly prewarm: () => Promise<void>;
  /** Clear all state and start a new session. */
  readonly newSession: () => void;
  readonly reset: () => Promise<Delivery>;
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
  readonly session: ComputedRef<ClientSessionState | undefined>;
  /**
   * Outstanding work: `"idle"`, `"resuming"` (catching up on an attached session), or `"busy"`.
   * Read `activeTurn(view)` for turn openness. Failures are reported separately in `error`.
   */
  readonly status: ComputedRef<UseEveAgentStatus>;
}

/**
 * Configuration for creating or binding a Vue eve agent session.
 *
 * Session configuration is read once when the composable creates its internal
 * store; to change the base URL or session, remount the component. For
 * credentials or headers that must change without remounting, pass function
 * values to `auth` or `headers`; the client resolves those before each request.
 *
 * Lifecycle callbacks (`onError`, `onEvent`, `onFinish`, `onSessionChange`,
 * `prepareSend`) are inherited from {@link SessionStoreCallbacks} and synced on
 * every render.
 */
export interface UseEveAgentOptions extends SessionStoreCallbacks {
  /**
   * Named agent mounted by a framework integration such as `withEve({ agents })`.
   *
   * `agent: "support"` targets same-origin routes under
   * `/eve/support/v1/...`. Do not combine with `baseUrl`.
   */
  readonly agent?: string;
  /** Authentication configuration; a function value is resolved per request. */
  readonly auth?: ClientAuth;
  /** Custom headers; a function value is resolved per request. */
  readonly headers?: HeadersValue;
  /**
   * Base URL used for eve client requests. Do not combine with `agent`.
   *
   * By default, requests target same-origin eve routes such as `/eve/v1/...`.
   * Pass a same-origin prefix such as `/api` to use an app-owned proxy, or an
   * absolute origin to talk to an eve server directly.
   *
   * @default ""
   */
  readonly baseUrl?: string;
  /** Ordered prefix of the session stream used to rehydrate projected state. */
  readonly initialEvents?: readonly SessionStreamEvent[];
  /** Prior session cursor to resume from on mount. */
  readonly initialSession?: ClientSessionState;
  /**
   * Project submitted user messages before eve confirms them with a
   * `delivery.consumed` fact.
   *
   * Such a message shows in `messages` only; `events` remains the
   * authoritative eve stream.
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
   * Externally owned {@link ClientSession} to bind instead of creating one.
   *
   * When set, `newSession()` reuses this session rather than constructing a new one.
   */
  readonly session?: ClientSession;
}

/**
 * Vue composable that drives one eve session and projects its event stream into
 * reactive UI state.
 *
 * Returns reactive refs for the conversation (`messages`, `agents`, `view`) and for `error`,
 * `events`, `session`, and `status`, plus `prewarm`, `send`, `respond`, `resume`, `cancel`,
 * `newSession`, and `reset`. Configuration is read once on store creation;
 * remount to change it. On scope dispose, the in-flight request is detached and
 * the store unsubscribed.
 */
export function useEveAgent(options: UseEveAgentOptions = {}): UseEveAgentReturn {
  if (options.resume && options.initialSession === undefined && options.session === undefined) {
    throw new Error("useEveAgent({ resume: true }) requires initialSession or session.");
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

  const snapshot = shallowRef<SessionStoreSnapshot>(store.snapshot);

  if ("window" in globalThis) {
    const unsubscribe = store.subscribe(() => {
      snapshot.value = store.snapshot;
    });
    attachSessionStore(store);
    if (options.resume) void store.resume().catch(() => {});

    onScopeDispose(() => {
      unsubscribe();
      detachSessionStore(store);
    });
  }

  return {
    cancel: () => store.cancel(),
    follow: (receipt) => store.follow(receipt),
    messages: computed(() => snapshot.value.messages),
    agents: computed(() => snapshot.value.agents),
    view: computed(() => snapshot.value.view),
    error: computed(() => snapshot.value.error),
    events: computed(() => snapshot.value.events),
    prewarm: () => store.prewarm(),
    reset: () => store.reset(),
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
    session: computed(() => snapshot.value.session),
    status: computed(() => snapshot.value.status),
  };
}
