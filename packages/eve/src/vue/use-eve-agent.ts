import type { Delivery } from "#shared/delivery.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { shallowRef, computed, onScopeDispose, type ComputedRef } from "vue";
import type { MessageContent } from "#shared/message-content.js";

import {
  attachEveAgentStore,
  detachEveAgentStore,
  EveAgentStore,
  type EveAgentStoreCallbacks,
  type EveAgentStoreSnapshot,
  type EveAgentStoreStatus,
  type PrepareSend,
} from "#client/eve-agent-store.js";
import { resolveEveAgentHost } from "#client/agent-host.js";
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
 * Lifecycle phase of a `useEveAgent` session: `"ready"` (idle), `"resuming"`
 * (checking an attached session), `"submitted"` (request sent, awaiting first
 * event), `"streaming"` (events arriving), or `"error"`.
 */
export type UseEveAgentStatus = EveAgentStoreStatus;

/**
 * Point-in-time projected state for an eve agent session (`data`, `error`,
 * `events`, `session`, `status`).
 *
 * `useEveAgent` passes this shape to callbacks such as `onFinish`, but exposes
 * the same fields as individual reactive refs on its return value.
 */
export type UseEveAgentSnapshot = EveAgentStoreSnapshot;

/**
 * Reactive return value from `useEveAgent`.
 */
export interface UseEveAgentReturn {
  /** Request durable cancellation of the active turn while continuing to receive its events. */
  readonly cancel: () => Promise<Delivery>;
  /** Rendered messages, local answers, native lifecycle tables, and followed agents. */
  readonly previews: ComputedRef<EveAgentStoreSnapshot["previews"]>;
  readonly messages: ComputedRef<EveAgentStoreSnapshot["messages"]>;
  readonly agents: ComputedRef<EveAgentStoreSnapshot["agents"]>;
  /** Last transport-level error, or `undefined` when healthy. */
  readonly error: ComputedRef<Error | undefined>;
  readonly view: ComputedRef<EveAgentStoreSnapshot["view"]>;
  /** Raw server events from this session (authoritative stream). */
  readonly events: ComputedRef<readonly SessionStreamEvent[]>;
  /** Resolves at the durable tail; the session stream keeps following afterward. */
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
   * Lifecycle phase: `"ready"` (idle), `"resuming"` (checking an attached
   * session), `"submitted"` (request sent, awaiting first event), `"streaming"`
   * (events arriving), or `"error"`.
   */
  readonly status: ComputedRef<UseEveAgentStatus>;
}

/**
 * Configuration for creating or binding a Vue eve agent session.
 *
 * Session configuration is read once when the composable creates its internal
 * store; to change the host or session, remount the component. For
 * credentials or headers that must change without remounting, pass function
 * values to `auth` or `headers`; the client resolves those before each request.
 *
 * Lifecycle callbacks (`onError`, `onEvent`, `onFinish`, `onSessionChange`,
 * `prepareSend`) are inherited from {@link EveAgentStoreCallbacks} and synced on
 * every render.
 */
export interface UseEveAgentOptions extends EveAgentStoreCallbacks {
  /**
   * Named agent mounted by a framework integration such as `withEve({ agents })`.
   *
   * `agent: "support"` targets same-origin routes under
   * `/eve/support/v1/...`. Do not combine with `host`.
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
  readonly host?: string;
  /** Ordered prefix of the session stream used to rehydrate projected state. */
  readonly initialEvents?: readonly SessionStreamEvent[];
  /** Prior session cursor to resume from on mount. */
  readonly initialSession?: ClientSessionState;
  /**
   * Project submitted user messages before eve confirms them with a
   * `delivery.consumed` fact.
   *
   * Such a message shows in `data.messages` only; `events` remains the
   * authoritative eve stream.
   *
   * @default true
   */
  readonly optimistic?: boolean;
  /** Follow each subagent call's session into `data.agents` while mounted. @default false */
  readonly followAgents?: boolean;
  /**
   * Keep the session stream open between turns to show events that arrive from schedules,
   * channels, or other clients. Set to false to close it once the session is idle and reopen it
   * on the next send, answer, or resume. @default true
   */
  readonly followIdle?: boolean;
  /** Prewarm an owned session on mount and after reset. @default false */
  readonly prewarm?: boolean;
  /** Replay the attached durable session after mount. Requires `initialSession` or `session`. */
  readonly resume?: boolean;
  /**
   * Externally owned {@link ClientSession} to bind instead of creating one.
   *
   * When set, `reset()` reuses this session rather than constructing a new one.
   */
  readonly session?: ClientSession;
}

/**
 * Vue composable that drives one eve session and projects its event stream into
 * reactive UI state.
 *
 * `data` is the conversation, including its message parts; derive anything else from `events`.
 * Returns reactive refs (`data`, `error`, `events`, `session`, `status`) plus
 * `prewarm`, `send`, `respond`, `resume`, `cancel`, and `reset`. Configuration is read once on store creation;
 * remount to change it. On scope dispose, the in-flight request is detached and
 * the store unsubscribed.
 */
export function useEveAgent(options: UseEveAgentOptions = {}): UseEveAgentReturn {
  if (options.resume && options.initialSession === undefined && options.session === undefined) {
    throw new Error("useEveAgent({ resume: true }) requires initialSession or session.");
  }
  const store = new EveAgentStore({
    auth: options.auth,
    headers: options.headers,
    host: resolveEveAgentHost({ agent: options.agent, host: options.host }),
    initialEvents: options.initialEvents,
    initialSession: options.initialSession,
    optimistic: options.optimistic,
    followAgents: options.followAgents,
    followIdle: options.followIdle,
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

  const snapshot = shallowRef<EveAgentStoreSnapshot>(store.snapshot);

  if ("window" in globalThis) {
    const unsubscribe = store.subscribe(() => {
      snapshot.value = store.snapshot;
    });
    attachEveAgentStore(store);
    if (options.resume) void store.resume().catch(() => {});

    onScopeDispose(() => {
      unsubscribe();
      detachEveAgentStore(store);
    });
  }

  return {
    cancel: () => store.cancel(),
    previews: computed(() => snapshot.value.previews),
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
