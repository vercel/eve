import type { Delivery } from "#shared/delivery.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { onMount } from "svelte";
import { createSubscriber } from "svelte/reactivity";
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
 * Session lifecycle phase: `"ready"` (idle), `"resuming"` (checking an
 * attached session), `"submitted"` (request sent, awaiting the first stream
 * event), `"streaming"` (events arriving), or `"error"`.
 */
export type UseEveAgentStatus = EveAgentStoreStatus;

/**
 * Immutable point-in-time view of an eve agent session: projected `data`, the
 * last `error`, the raw `events` stream, the `session` cursor, and `status`.
 * `useEveAgent` passes this snapshot to the `onFinish` callback.
 */
export type UseEveAgentSnapshot = EveAgentStoreSnapshot;

/**
 * Reactive return value from `useEveAgent`.
 *
 * The state properties are Svelte 5 rune-friendly getters. Read them from a
 * template, `$derived`, or `$effect` and Svelte will update when eve streams
 * new events.
 */
export interface UseEveAgentReturn {
  /** Request durable cancellation of the active turn while continuing to receive its events. */
  readonly cancel: () => Promise<Delivery>;
  /** Rendered messages, local answers, native lifecycle tables, and followed agents. */
  readonly previews: EveAgentStoreSnapshot["previews"];
  readonly messages: EveAgentStoreSnapshot["messages"];
  readonly agents: EveAgentStoreSnapshot["agents"];
  /** Last transport-level error, or `undefined` when healthy. */
  readonly error: Error | undefined;
  readonly view: EveAgentStoreSnapshot["view"];
  /** Raw server events received during this session (authoritative stream). */
  readonly events: readonly SessionStreamEvent[];
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
  readonly session: ClientSessionState | undefined;
  /**
   * Lifecycle phase: `"ready"` (idle), `"resuming"` (checking an attached
   * session), `"submitted"` (request sent, awaiting first event), `"streaming"`
   * (events arriving), or `"error"`.
   */
  readonly status: UseEveAgentStatus;
}

/**
 * Configuration for a Svelte eve agent session.
 *
 * Read once when `useEveAgent` creates its store; create a new binding to
 * change host or session. To rotate credentials or headers without
 * recreating the binding, pass function values to `auth` or `headers`, which
 * the client resolves before each HTTP request.
 */
export interface UseEveAgentOptions extends EveAgentStoreCallbacks {
  /**
   * Named agent mounted by a framework integration such as `withEve({ agents })`.
   *
   * `agent: "support"` targets same-origin routes under
   * `/eve/support/v1/...`. Do not combine with `host`.
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
  readonly host?: string;
  /** Ordered prefix of the session stream used to rehydrate projected state. */
  readonly initialEvents?: readonly SessionStreamEvent[];
  /** Seed session identity and stream cursor for resuming a prior conversation. */
  readonly initialSession?: ClientSessionState;
  /**
   * Project submitted user messages before eve confirms them with a
   * `delivery.consumed` fact. Such a message shows in `data.messages` only;
   * `events` stays the authoritative eve stream.
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
   * Pre-built client session to bind to. When omitted, the binding creates its
   * own session from `auth`, `headers`, and `host`.
   */
  readonly session?: ClientSession;
}

class SvelteEveAgent implements UseEveAgentReturn {
  #snapshot: EveAgentStoreSnapshot;
  readonly #store: EveAgentStore;
  readonly #subscribe: () => void;

  constructor(store: EveAgentStore) {
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
      };
    });
  }

  get previews(): EveAgentStoreSnapshot["previews"] {
    this.#subscribe();
    return this.#snapshot.previews;
  }
  get messages(): EveAgentStoreSnapshot["messages"] {
    this.#subscribe();
    return this.#snapshot.messages;
  }
  get agents(): EveAgentStoreSnapshot["agents"] {
    this.#subscribe();
    return this.#snapshot.agents;
  }

  get view(): EveAgentStoreSnapshot["view"] {
    this.#subscribe();
    return this.#snapshot.view;
  }

  get error(): Error | undefined {
    this.#subscribe();
    return this.#snapshot.error;
  }

  get events(): readonly SessionStreamEvent[] {
    this.#subscribe();
    return this.#snapshot.events;
  }

  get session(): ClientSessionState | undefined {
    this.#subscribe();
    return this.#snapshot.session;
  }

  get status(): UseEveAgentStatus {
    this.#subscribe();
    return this.#snapshot.status;
  }

  cancel = (): Promise<Delivery> => {
    return this.#store.cancel();
  };

  newSession = (): void => {
    this.#store.newSession();
  };
  reset = (): Promise<Delivery> => this.#store.reset();
  clear = (): Promise<Delivery> => this.#store.clear();
  compact = (): Promise<Delivery> => this.#store.compact();

  prewarm = (): Promise<void> => {
    return this.#store.prewarm();
  };

  resume = (): Promise<void> => {
    return this.#store.resume();
  };

  respond = <TOutput = unknown>(
    answers: Parameters<ClientSession["respond"]>[0],
    options?: RespondTurnOptions<TOutput>,
  ): Promise<Delivery<TOutput>> => {
    return this.#store.send({ ...options, answers });
  };

  send = <TOutput = unknown>(
    message: MessageContent,
    options?: SendTurnOptions<TOutput>,
  ): Promise<Delivery<TOutput>> => {
    return this.#store.send({ ...options, message });
  };
}

/**
 * Svelte 5 binding that drives an eve session and projects its events into
 * rune-friendly reactive data.
 *
 * `data` is the conversation, including its message parts; derive anything else from `events`.
 * Configuration is read once; create a new binding to change host or session.
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
  if ("window" in globalThis)
    onMount(() => {
      attachEveAgentStore(store);
      if (options.resume) void store.resume().catch(() => {});
      return () => detachEveAgentStore(store);
    });

  return new SvelteEveAgent(store);
}
