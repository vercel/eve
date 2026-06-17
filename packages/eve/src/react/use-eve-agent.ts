import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";

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
 * Lifecycle status of an eve agent session.
 *
 * - `"ready"`: idle, accepting a new turn.
 * - `"submitted"`: a turn was sent, no stream events received yet.
 * - `"streaming"`: stream events are arriving for the active turn.
 * - `"error"`: the last turn ended in a terminal failure (see `snapshot.error`).
 */
export type UseEveAgentStatus = EveAgentStoreStatus;

/**
 * Snapshot of an eve agent session: `data` (the reducer projection), `events`
 * (the authoritative server stream), `session` (resumable cursor), `status`,
 * and `error`.
 */
export type UseEveAgentSnapshot<TData> = EveAgentStoreSnapshot<TData>;

/**
 * Snapshot plus commands returned by `useEveAgent`.
 */
export interface UseEveAgentHelpers<TData> extends UseEveAgentSnapshot<TData> {
  /** Resets the session: aborts any in-flight turn, recreates the owned session, and clears events and projected data. */
  readonly reset: () => void;
  /** Sends a turn (message, HITL responses, and/or client context). Rejects if a turn is already in flight. */
  readonly send: <TOutput = unknown>(input: SendTurnPayload<TOutput>) => Promise<void>;
  /** Aborts the in-flight turn's stream, if any. */
  readonly stop: () => void;
}

/**
 * Configuration for creating or binding a React eve agent session.
 *
 * Session configuration is read when the hook creates its internal store;
 * remount the component to point at a different host, reducer, or session.
 * Lifecycle callbacks update on every render.
 *
 * For credentials or headers that must change without remounting, pass function
 * values to `auth` or `headers`; the client resolves those before each request.
 */
export interface UseEveAgentOptions<TData> extends EveAgentStoreCallbacks<TData> {
  readonly auth?: ClientAuth;
  readonly headers?: HeadersValue;
  /**
   * Base URL for eve client requests.
   *
   * Defaults to same-origin eve routes such as `/eve/v1/...`. Pass a same-origin
   * prefix such as `/api` for an app-owned proxy, or an absolute origin to talk
   * to an eve server directly.
   *
   * @default ""
   */
  readonly host?: string;
  readonly initialEvents?: readonly HandleMessageStreamEvent[];
  readonly initialSession?: SessionState;
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
  readonly reducer?: EveAgentReducer<TData>;
  readonly session?: ClientSession;
}

export function useEveAgent(
  options?: UseEveAgentOptions<EveMessageData>,
): UseEveAgentHelpers<EveMessageData>;

export function useEveAgent<TData>(
  options: UseEveAgentOptions<TData> & { readonly reducer: EveAgentReducer<TData> },
): UseEveAgentHelpers<TData>;

/**
 * React hook that drives an eve session and projects its event stream into UI data.
 *
 * Returns the current snapshot (`data`, `events`, `session`, `status`, `error`)
 * plus the commands `send`, `stop`, and `reset`. With no reducer, `data` is the
 * built-in `UIMessage` projection from {@link defaultMessageReducer} (`TData`
 * is {@link EveMessageData}); pass a reducer to project into your own shape and
 * infer `TData`.
 *
 * Session-shaping options (`host`, `reducer`, `session`, `initialEvents`,
 * `initialSession`, `auth`, `headers`, `maxReconnectAttempts`, `optimistic`) are
 * read once when the store is created; remount to change them. Lifecycle
 * callbacks (`onError`, `onEvent`, `onFinish`, `onSessionChange`, `prepareSend`)
 * refresh on every render.
 */
export function useEveAgent<TData>(
  options: UseEveAgentOptions<TData> = {},
): UseEveAgentHelpers<TData> {
  const storeRef = useRef<EveAgentStore<TData> | undefined>(undefined);

  if (!storeRef.current) {
    const reducer = options.reducer ?? (defaultMessageReducer() as EveAgentReducer<TData>);
    storeRef.current = new EveAgentStore({
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
  }

  const store = storeRef.current;
  store.setCallbacks({
    onError: options.onError,
    onEvent: options.onEvent,
    onFinish: options.onFinish,
    onSessionChange: options.onSessionChange,
    prepareSend: options.prepareSend,
  });

  const subscribe = useCallback(
    (onStoreChange: () => void) => store.subscribe(onStoreChange),
    [store],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    () => store.snapshot,
    () => store.snapshot,
  );

  const reset = useCallback(() => store.reset(), [store]);
  const send = useCallback(
    <TOutput = unknown>(input: SendTurnPayload<TOutput>) => {
      return store.send(input);
    },
    [store],
  );
  const stop = useCallback(() => store.stop(), [store]);

  return useMemo(
    () => ({
      ...snapshot,
      reset,
      send,
      stop,
    }),
    [reset, send, snapshot, stop],
  );
}
