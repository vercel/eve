import type { SessionStreamEvent } from "#protocol/session-event.js";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

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
 * - `"resuming"`: checking an attached session for events; submission is disabled.
 * - `"submitted"`: a turn was sent, no stream events received yet.
 * - `"streaming"`: stream events are arriving for the active turn.
 * - `"error"`: the last turn ended in a terminal failure (see `snapshot.error`).
 */
export type UseEveAgentStatus = EveAgentStoreStatus;

/**
 * Snapshot of an eve agent session: `data` (the conversation), `events` (the authoritative
 * server stream), `session` (resumable cursor), `status`, and `error`.
 */
export type UseEveAgentSnapshot = EveAgentStoreSnapshot;

/**
 * Snapshot plus commands returned by `useEveAgent`.
 */
export interface UseEveAgentHelpers extends UseEveAgentSnapshot {
  /** Requests durable cancellation of the active turn while continuing to receive its events. */
  readonly cancel: () => Promise<CancelSessionResult>;
  /** Replays the attached durable session and follows its in-flight turn, if any. */
  readonly resume: () => Promise<void>;
  /** Creates the session without starting its first turn. */
  readonly prewarm: () => Promise<void>;
  /** Resets the session: detaches any local stream and clears events and projected data. */
  readonly reset: () => void;
  /** Sends a message. While a turn is active, pass `turnPolicy: "steer"` to replace it. */
  readonly send: <TOutput = unknown>(
    message: string | UserContent,
    options?: SendTurnOptions<TOutput>,
  ) => Promise<void>;
  /** Answers pending HITL input requests. Rejects if a turn is already in flight. */
  readonly respond: <TOutput = unknown>(
    answers: Parameters<ClientSession["respond"]>[0],
    options?: RespondTurnOptions<TOutput>,
  ) => Promise<void>;
}

/**
 * Configuration for creating or binding a React eve agent session.
 *
 * Session configuration is read when the hook creates its internal store;
 * remount the component to point at a different host or session.
 * Lifecycle callbacks update on every render.
 *
 * For credentials or headers that must change without remounting, pass function
 * values to `auth` or `headers`; the client resolves those before each request.
 */
export interface UseEveAgentOptions extends EveAgentStoreCallbacks {
  /**
   * Named agent mounted by a framework integration such as `withEve({ agents })`.
   *
   * `agent: "support"` targets same-origin routes under
   * `/eve/support/v1/...`. Do not combine with `host`.
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
  readonly initialEvents?: readonly SessionStreamEvent[];
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
  readonly followSubagents?: boolean;
  /**
   * Keep the session stream open between turns to show events that arrive from schedules,
   * channels, or other clients. Set to false to close it once the session is idle and reopen it
   * on the next send, answer, or resume. @default true
   */
  readonly followIdle?: boolean;
  /**
   * Prewarm an owned session when true. React observes this value across renders;
   * changing it from false to true prepares the current session, and reset checks
   * the latest rendered value before preparing the next session.
   *
   * Changing the value to false does not discard an existing session or abort
   * session creation already in flight.
   *
   * @default false
   */
  readonly prewarm?: boolean;
  /**
   * Replay the attached durable session after mount and follow its in-flight
   * turn, if any. Requires `initialSession` or `session`.
   *
   * @default false
   */
  readonly resume?: boolean;
  readonly session?: ClientSession;
}

/**
 * React hook that drives an eve session and projects its event stream into UI data.
 *
 * Returns the current snapshot (`data`, `events`, `session`, `status`, `error`)
 * plus the commands `prewarm`, `send`, `respond`, `resume`, `cancel`, and `reset`. `data` is the
 * conversation (`messages`, `turns`, `interactions`, `tasks`, `agents`); derive anything else
 * from `events`.
 *
 * Session-shaping options (`host`, `session`, `initialEvents`,
 * `initialSession`, `auth`, `headers`, `optimistic`, `resume`) are read once
 * when the store is created; remount to change them. `prewarm` and lifecycle
 * callbacks (`onError`, `onEvent`, `onFinish`, `onSessionChange`, `prepareSend`)
 * refresh on every render.
 */
export function useEveAgent(options: UseEveAgentOptions = {}): UseEveAgentHelpers {
  const storeRef = useRef<EveAgentStore | undefined>(undefined);
  const mountedRef = useRef(false);
  const resumeOnMountRef = useRef(options.resume ?? false);
  const [autoResumePending, setAutoResumePending] = useState(resumeOnMountRef.current);
  const [prewarmResetGeneration, setPrewarmResetGeneration] = useState(0);
  const shouldPrewarm = options.prewarm ?? false;

  if (!storeRef.current) {
    if (
      resumeOnMountRef.current &&
      options.initialSession === undefined &&
      options.session === undefined
    ) {
      throw new Error("useEveAgent({ resume: true }) requires initialSession or session.");
    }
    storeRef.current = new EveAgentStore({
      auth: options.auth,
      headers: options.headers,
      host: resolveEveAgentHost({ agent: options.agent, host: options.host }),
      initialEvents: options.initialEvents,
      initialSession: options.initialSession,
      optimistic: options.optimistic,
      followSubagents: options.followSubagents,
      followIdle: options.followIdle,
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

  useEffect(() => {
    mountedRef.current = true;
    const timeout = setTimeout(() => attachEveAgentStore(store), 0);
    return () => {
      mountedRef.current = false;
      clearTimeout(timeout);
      // Strict Mode and Fast Refresh replay this cleanup and setup in one synchronous commit.
      queueMicrotask(() => {
        if (!mountedRef.current) detachEveAgentStore(store);
      });
    };
  }, [store]);
  useEffect(() => {
    if (!shouldPrewarm) return;
    const timeout = setTimeout(() => void store.prewarm().catch(() => {}), 0);
    return () => clearTimeout(timeout);
  }, [prewarmResetGeneration, shouldPrewarm, store]);
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
  const reset = useCallback(() => {
    store.reset();
    setPrewarmResetGeneration((generation) => generation + 1);
  }, [store]);
  const prewarm = useCallback(() => store.prewarm(), [store]);
  const resume = useCallback(() => store.resume(), [store]);
  const send = useCallback(
    <TOutput = unknown>(message: string | UserContent, options?: SendTurnOptions<TOutput>) => {
      return store.send({ ...options, message });
    },
    [store],
  );
  const respond = useCallback(
    <TOutput = unknown>(
      answers: Parameters<ClientSession["respond"]>[0],
      options?: RespondTurnOptions<TOutput>,
    ) => store.send({ ...options, answers }),
    [store],
  );
  const visibleSnapshot =
    autoResumePending && snapshot.status === "ready"
      ? { ...snapshot, status: "resuming" as const }
      : snapshot;

  return useMemo(
    () => ({
      ...visibleSnapshot,
      cancel,
      prewarm,
      reset,
      respond,
      resume,
      send,
    }),
    [cancel, prewarm, reset, respond, resume, send, visibleSnapshot],
  );
}
