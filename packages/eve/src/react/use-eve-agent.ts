import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  detachEveAgentStore,
  EveAgentStore,
  type EveAgentStoreCallbacks,
  type EveAgentStoreSnapshot,
  type EveAgentStoreStatus,
  type PrepareSend,
} from "#client/eve-agent-store.js";
import { resolveEveAgentHost } from "#client/agent-host.js";
import type { EveAgentReducer } from "#client/reducer.js";
import type { ClientSession } from "#client/session.js";
import { defaultMessageReducer, type EveMessageData } from "#client/message-reducer.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import type { UserContent } from "ai";
import type {
  CancelSessionResult,
  ClientAuth,
  HeadersValue,
  RespondTurnOptions,
  SendTurnOptions,
  ClientSessionState,
} from "#client/types.js";

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
  /** Requests durable cancellation of the active turn while continuing to receive its events. */
  readonly cancel: () => Promise<CancelSessionResult>;
  /** Replays the attached durable session and follows its in-flight turn, if any. */
  readonly resume: () => Promise<void>;
  /** Resets the session: detaches any local stream, recreates the owned session, and clears events and projected data. */
  readonly reset: () => void;
  /** Sends a message. While a turn is active, pass `turnPolicy: "steer"` to replace it. */
  readonly send: <TOutput = unknown>(
    message: string | UserContent,
    options?: SendTurnOptions<TOutput>,
  ) => Promise<void>;
  /** Answers pending HITL input requests. Rejects if a turn is already in flight. */
  readonly respond: <TOutput = unknown>(
    inputResponses: Parameters<ClientSession["respond"]>[0],
    options?: RespondTurnOptions<TOutput>,
  ) => Promise<void>;
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
  /**
   * Named agent mounted by a framework integration such as `withEve({ agents })`.
   *
   * `agent: "support"` targets same-origin routes under
   * `/eve/agents/support/eve/v1/...`. Do not combine with `host`.
   */
  readonly agent?: string;
  readonly auth?: ClientAuth;
  readonly headers?: HeadersValue;
  /**
   * Base URL for eve client requests. Do not combine with `agent`.
   *
   * Defaults to same-origin eve routes such as `/eve/v1/...`. Pass a same-origin
   * prefix such as `/api` for an app-owned proxy, or an absolute origin to talk
   * to an eve server directly.
   *
   * @default ""
   */
  readonly host?: string;
  /** Ordered prefix of the session stream used to rehydrate projected state. */
  readonly initialEvents?: readonly MessageStreamEvent[];
  readonly initialSession?: ClientSessionState;
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
  /**
   * Replay the attached durable session after mount and follow its in-flight
   * turn, if any. Requires `initialSession` or `session`.
   *
   * @default false
   */
  readonly resume?: boolean;
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
 * plus the commands `send`, `respond`, `resume`, `cancel`, and `reset`. With no reducer, `data` is the
 * built-in `UIMessage` projection from {@link defaultMessageReducer} (`TData`
 * is {@link EveMessageData}); pass a reducer to project into your own shape and
 * infer `TData`.
 *
 * Session-shaping options (`host`, `reducer`, `session`, `initialEvents`,
 * `initialSession`, `auth`, `headers`, `optimistic`, `resume`) are
 * read once when the store is created; remount to change them. Lifecycle
 * callbacks (`onError`, `onEvent`, `onFinish`, `onSessionChange`, `prepareSend`)
 * refresh on every render.
 */
export function useEveAgent<TData>(
  options: UseEveAgentOptions<TData> = {},
): UseEveAgentHelpers<TData> {
  const storeRef = useRef<EveAgentStore<TData> | undefined>(undefined);
  const resumeOnMountRef = useRef(options.resume ?? false);
  const [autoResumePending, setAutoResumePending] = useState(resumeOnMountRef.current);

  if (!storeRef.current) {
    if (
      resumeOnMountRef.current &&
      options.initialSession === undefined &&
      options.session === undefined
    ) {
      throw new Error("useEveAgent({ resume: true }) requires initialSession or session.");
    }
    const reducer = options.reducer ?? (defaultMessageReducer() as EveAgentReducer<TData>);
    storeRef.current = new EveAgentStore({
      auth: options.auth,
      headers: options.headers,
      host: resolveEveAgentHost({ agent: options.agent, host: options.host }),
      initialEvents: options.initialEvents,
      initialSession: options.initialSession,
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

  useEffect(() => () => detachEveAgentStore(store), [store]);
  useEffect(() => {
    if (!resumeOnMountRef.current) return;
    let active = true;
    const finish = () => {
      if (active) setAutoResumePending(false);
    };
    const timeout = setTimeout(() => void store.resume().then(finish, finish), 0);
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [store]);

  const cancel = useCallback(() => store.cancel(), [store]);
  const reset = useCallback(() => store.reset(), [store]);
  const resume = useCallback(() => store.resume(), [store]);
  const send = useCallback(
    <TOutput = unknown>(message: string | UserContent, options?: SendTurnOptions<TOutput>) => {
      return store.send({ ...options, message });
    },
    [store],
  );
  const respond = useCallback(
    <TOutput = unknown>(
      inputResponses: Parameters<ClientSession["respond"]>[0],
      options?: RespondTurnOptions<TOutput>,
    ) => store.send({ ...options, inputResponses }),
    [store],
  );
  const visibleSnapshot =
    autoResumePending && snapshot.status === "ready"
      ? { ...snapshot, status: "submitted" as const }
      : snapshot;

  return useMemo(
    () => ({
      ...visibleSnapshot,
      cancel,
      reset,
      respond,
      resume,
      send,
    }),
    [cancel, reset, respond, resume, send, visibleSnapshot],
  );
}
