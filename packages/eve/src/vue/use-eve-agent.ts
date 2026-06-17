import { shallowRef, computed, onScopeDispose, type ComputedRef } from "vue";

import {
  EveAgentStore,
  type EveAgentStoreCallbacks,
  type EveAgentStoreSnapshot,
  type EveAgentStoreStatus,
  type PrepareSend,
} from "#client/eve-agent-store.js";
import type { EveAgentReducer } from "#client/reducer.js";
import type { ClientSession } from "#client/session.js";
import { defaultMessageReducer, type EveMessageData } from "#client/message-reducer.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { ClientAuth, HeadersValue, SendTurnPayload, SessionState } from "#client/types.js";

export type { PrepareSend };

/**
 * Lifecycle phase of a `useEveAgent` session: `"ready"` (idle), `"submitted"`
 * (request sent, awaiting first event), `"streaming"` (events arriving), or
 * `"error"`.
 */
export type UseEveAgentStatus = EveAgentStoreStatus;

/**
 * Point-in-time projected state for an eve agent session (`data`, `error`,
 * `events`, `session`, `status`).
 *
 * `useEveAgent` passes this shape to callbacks such as `onFinish`, but exposes
 * the same fields as individual reactive refs on its return value.
 */
export type UseEveAgentSnapshot<TData> = EveAgentStoreSnapshot<TData>;

/**
 * Reactive return value from `useEveAgent`.
 */
export interface UseEveAgentReturn<TData> {
  /** Projected state: the reducer folds every stream event into this value. */
  readonly data: ComputedRef<TData>;
  /** Last transport-level error, or `undefined` when healthy. */
  readonly error: ComputedRef<Error | undefined>;
  /** Raw server events from this session (authoritative stream). */
  readonly events: ComputedRef<readonly HandleMessageStreamEvent[]>;
  /** Clear all state and start a new session. */
  readonly reset: () => void;
  /** Send a turn with full structured input (message, attachments, input responses). */
  readonly send: <TOutput = unknown>(input: SendTurnPayload<TOutput>) => Promise<void>;
  /** Current session identity and stream cursor. */
  readonly session: ComputedRef<SessionState>;
  /** Lifecycle phase: `"ready"` (idle), `"submitted"` (request sent, awaiting first event), `"streaming"` (events arriving), or `"error"`. */
  readonly status: ComputedRef<UseEveAgentStatus>;
  /** Abort the in-flight request. */
  readonly stop: () => void;
}

/**
 * Configuration for creating or binding a Vue eve agent session.
 *
 * Session configuration is read once when the composable creates its internal
 * store; to change the host, reducer, or session, remount the component. For
 * credentials or headers that must change without remounting, pass function
 * values to `auth` or `headers`; the client resolves those before each request.
 *
 * Lifecycle callbacks (`onError`, `onEvent`, `onFinish`, `onSessionChange`,
 * `prepareSend`) are inherited from {@link EveAgentStoreCallbacks} and synced on
 * every render.
 */
export interface UseEveAgentOptions<TData> extends EveAgentStoreCallbacks<TData> {
  /** Authentication configuration; a function value is resolved per request. */
  readonly auth?: ClientAuth;
  /** Custom headers; a function value is resolved per request. */
  readonly headers?: HeadersValue;
  /**
   * Base URL used for eve client requests.
   *
   * By default, requests target same-origin eve routes such as `/eve/v1/...`.
   * Pass a same-origin prefix such as `/api` to use an app-owned proxy, or an
   * absolute origin to talk to an eve server directly.
   *
   * @default ""
   */
  readonly host?: string;
  /** Prior stream events to rehydrate the projected state from on mount. */
  readonly initialEvents?: readonly HandleMessageStreamEvent[];
  /** Prior session cursor to resume from on mount. */
  readonly initialSession?: SessionState;
  /** Maximum SSE reconnection attempts per turn. @default 3 */
  readonly maxReconnectAttempts?: number;
  /**
   * Project submitted user messages before eve confirms them with a
   * `message.received` stream event.
   *
   * Optimistic events are reducer-facing projection events only. They are not
   * exposed through `events`, which remains the authoritative eve stream.
   *
   * @default true
   */
  readonly optimistic?: boolean;
  /**
   * Projects stream events into `TData`.
   *
   * @default defaultMessageReducer()
   */
  readonly reducer?: EveAgentReducer<TData>;
  /**
   * Externally owned {@link ClientSession} to bind instead of creating one.
   *
   * When set, `reset()` reuses this session rather than constructing a new one.
   */
  readonly session?: ClientSession;
}

export function useEveAgent(
  options?: UseEveAgentOptions<EveMessageData>,
): UseEveAgentReturn<EveMessageData>;

export function useEveAgent<TData>(
  options: UseEveAgentOptions<TData> & { readonly reducer: EveAgentReducer<TData> },
): UseEveAgentReturn<TData>;

/**
 * Vue composable that drives one eve session and projects its event stream into
 * reactive UI state.
 *
 * Without a `reducer`, events project into `EveMessageData` via
 * `defaultMessageReducer()`; pass `reducer` to project into a custom `TData`.
 * Returns reactive refs (`data`, `error`, `events`, `session`, `status`) plus
 * `send`, `stop`, and `reset`. Configuration is read once on store creation;
 * remount to change it. On scope dispose, the in-flight request is aborted and
 * the store unsubscribed.
 */
export function useEveAgent<TData>(
  options: UseEveAgentOptions<TData> = {},
): UseEveAgentReturn<TData> {
  const reducer = options.reducer ?? (defaultMessageReducer() as EveAgentReducer<TData>);

  const store = new EveAgentStore<TData>({
    auth: options.auth,
    headers: options.headers,
    host: options.host,
    initialEvents: options.initialEvents,
    initialSession: options.initialSession,
    maxReconnectAttempts: options.maxReconnectAttempts,
    optimistic: options.optimistic,
    reducer,
    session: options.session,
  });

  store.setCallbacks({
    onError: options.onError,
    onEvent: options.onEvent,
    onFinish: options.onFinish,
    onSessionChange: options.onSessionChange,
    prepareSend: options.prepareSend,
  });

  const snapshot = shallowRef<EveAgentStoreSnapshot<TData>>(store.snapshot);

  if ("window" in globalThis) {
    const unsubscribe = store.subscribe(() => {
      snapshot.value = store.snapshot;
    });

    onScopeDispose(() => {
      unsubscribe();
      store.stop();
    });
  }

  return {
    data: computed(() => snapshot.value.data),
    error: computed(() => snapshot.value.error),
    events: computed(() => snapshot.value.events),
    reset: () => store.reset(),
    send: <TOutput = unknown>(input: SendTurnPayload<TOutput>) => store.send(input),
    session: computed(() => snapshot.value.session),
    status: computed(() => snapshot.value.status),
    stop: () => store.stop(),
  };
}
