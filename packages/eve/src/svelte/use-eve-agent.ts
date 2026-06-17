import { createSubscriber } from "svelte/reactivity";

import {
  EveAgentStore,
  type EveAgentStoreCallbacks,
  type EveAgentStoreSnapshot,
  type EveAgentStoreStatus,
  type PrepareSend,
} from "#client/eve-agent-store.js";
import { defaultMessageReducer, type EveMessageData } from "#client/message-reducer.js";
import type { EveAgentReducer } from "#client/reducer.js";
import type { ClientSession } from "#client/session.js";
import type { ClientAuth, HeadersValue, SendTurnPayload, SessionState } from "#client/types.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

export type { PrepareSend };

/**
 * Session lifecycle phase: `"ready"` (idle), `"submitted"` (request sent,
 * awaiting the first stream event), `"streaming"` (events arriving), or
 * `"error"`.
 */
export type UseEveAgentStatus = EveAgentStoreStatus;

/**
 * Immutable point-in-time view of an eve agent session: projected `data`, the
 * last `error`, the raw `events` stream, the `session` cursor, and `status`.
 * `useEveAgent` passes this snapshot to the `onFinish` callback.
 */
export type UseEveAgentSnapshot<TData> = EveAgentStoreSnapshot<TData>;

/**
 * Reactive return value from `useEveAgent`.
 *
 * The state properties are Svelte 5 rune-friendly getters. Read them from a
 * template, `$derived`, or `$effect` and Svelte will update when eve streams
 * new events.
 */
export interface UseEveAgentReturn<TData> {
  /** Projected state built by reducing every stream event through the reducer. */
  readonly data: TData;
  /** Last transport-level error, or `undefined` when healthy. */
  readonly error: Error | undefined;
  /** Raw server events received during this session (authoritative stream). */
  readonly events: readonly HandleMessageStreamEvent[];
  /** Clear all state and start a new session. */
  readonly reset: () => void;
  /** Send a turn with full structured input (message, attachments, input responses). */
  readonly send: <TOutput = unknown>(input: SendTurnPayload<TOutput>) => Promise<void>;
  /** Current session identity and stream cursor. */
  readonly session: SessionState;
  /** Lifecycle phase: `"ready"` (idle), `"submitted"` (request sent, awaiting first event), `"streaming"` (events arriving), or `"error"`. */
  readonly status: UseEveAgentStatus;
  /** Abort the in-flight request. */
  readonly stop: () => void;
}

/**
 * Configuration for a Svelte eve agent session.
 *
 * Read once when `useEveAgent` creates its store; create a new binding to
 * change host, reducer, or session. To rotate credentials or headers without
 * recreating the binding, pass function values to `auth` or `headers`, which
 * the client resolves before each HTTP request.
 */
export interface UseEveAgentOptions<TData> extends EveAgentStoreCallbacks<TData> {
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
   * Base URL for eve client requests. Empty targets same-origin eve routes
   * such as `/eve/v1/...`; a same-origin prefix like `/api` routes through an
   * app-owned proxy; an absolute origin hits an eve server directly.
   *
   * @default ""
   */
  readonly host?: string;
  /** Seed events for resuming a prior conversation. */
  readonly initialEvents?: readonly HandleMessageStreamEvent[];
  /** Seed session identity and stream cursor for resuming a prior conversation. */
  readonly initialSession?: SessionState;
  /**
   * Maximum number of stream reconnection attempts per turn.
   *
   * @default 3
   */
  readonly maxReconnectAttempts?: number;
  /**
   * Project submitted user messages before eve confirms them with a
   * `message.received` stream event. Optimistic events are reducer-facing
   * projection only and never appear in `events`, which stays the
   * authoritative eve stream.
   *
   * @default true
   */
  readonly optimistic?: boolean;
  /**
   * Projects stream events into `TData`. Defaults to {@link defaultMessageReducer},
   * which fixes `TData` to {@link EveMessageData}.
   */
  readonly reducer?: EveAgentReducer<TData>;
  /**
   * Pre-built client session to bind to. When omitted, the binding creates its
   * own session from `auth`, `headers`, and `host`.
   */
  readonly session?: ClientSession;
}

class SvelteEveAgent<TData> implements UseEveAgentReturn<TData> {
  #snapshot: EveAgentStoreSnapshot<TData>;
  readonly #store: EveAgentStore<TData>;
  readonly #subscribe: () => void;

  constructor(store: EveAgentStore<TData>) {
    this.#store = store;
    this.#snapshot = store.snapshot;
    this.#subscribe = createSubscriber((update) => {
      if (!("window" in globalThis)) return;

      const unsubscribe = store.subscribe(() => {
        this.#snapshot = store.snapshot;
        update();
      });

      return () => {
        unsubscribe();
        store.stop();
      };
    });
  }

  get data(): TData {
    this.#subscribe();
    return this.#snapshot.data;
  }

  get error(): Error | undefined {
    this.#subscribe();
    return this.#snapshot.error;
  }

  get events(): readonly HandleMessageStreamEvent[] {
    this.#subscribe();
    return this.#snapshot.events;
  }

  get session(): SessionState {
    this.#subscribe();
    return this.#snapshot.session;
  }

  get status(): UseEveAgentStatus {
    this.#subscribe();
    return this.#snapshot.status;
  }

  reset = (): void => {
    this.#store.reset();
  };

  send = <TOutput = unknown>(input: SendTurnPayload<TOutput>): Promise<void> => {
    return this.#store.send(input);
  };

  stop = (): void => {
    this.#store.stop();
  };
}

export function useEveAgent(
  options?: UseEveAgentOptions<EveMessageData>,
): UseEveAgentReturn<EveMessageData>;

export function useEveAgent<TData>(
  options: UseEveAgentOptions<TData> & { readonly reducer: EveAgentReducer<TData> },
): UseEveAgentReturn<TData>;

/**
 * Svelte 5 binding that drives an eve session and projects its events into
 * rune-friendly reactive data.
 *
 * Without a `reducer`, projects to {@link EveMessageData} via
 * {@link defaultMessageReducer}; pass a `reducer` for a different `TData`.
 * Configuration is read once; create a new binding to change host, reducer,
 * or session.
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

  return new SvelteEveAgent(store);
}
