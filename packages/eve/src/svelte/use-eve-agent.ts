import type { Delivery } from "#shared/delivery.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { onMount } from "svelte";
import { createSubscriber } from "svelte/reactivity";
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
 * Immutable point-in-time view of an eve agent session: the conversation (`messages`,
 * `agents`, `view`), the last `error`, the raw `events` stream, the
 * `session` cursor, and `status`.
 * `useEveAgent` passes this snapshot to the `onFinish` callback.
 */
export type UseEveAgentSnapshot = SessionStoreSnapshot;

/**
 * Reactive return value from `useEveAgent`.
 *
 * The state properties are Svelte 5 rune-friendly getters. Read them from a
 * template, `$derived`, or `$effect` and Svelte will update when eve streams
 * new events.
 */
export interface UseEveAgentReturn {
  /**
   * Request durable cancellation of the active turn while continuing to receive its events.
   * Offer it while `activeTurn(view)` returns a turn, including one waiting on a person.
   */
  readonly cancel: () => Promise<Delivery>;
  /** Rendered messages, local answers, native lifecycle tables, and followed agents. */
  readonly messages: SessionStoreSnapshot["messages"];
  readonly agents: SessionStoreSnapshot["agents"];
  /** Last transport-level error, or `undefined` when healthy. */
  readonly error: Error | undefined;
  readonly view: SessionStoreSnapshot["view"];
  /** Raw server events received during this session (authoritative stream). */
  readonly events: readonly SessionStreamEvent[];
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
  readonly session: ClientSessionState | undefined;
  /**
   * Outstanding work: `"idle"`, `"resuming"` (catching up on an attached session), or `"busy"`.
   * Read `activeTurn(view)` for turn openness. Failures are reported separately in `error`.
   */
  readonly status: UseEveAgentStatus;
}

/**
 * Configuration for a Svelte eve agent session.
 *
 * Read once when `useEveAgent` creates its store; create a new binding to
 * change base URL or session. To rotate credentials or headers without
 * recreating the binding, pass function values to `auth` or `headers`, which
 * the client resolves before each HTTP request.
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

class SvelteEveAgent implements UseEveAgentReturn {
  #snapshot: SessionStoreSnapshot;
  readonly #store: SessionStore;
  readonly #subscribe: () => void;

  constructor(store: SessionStore) {
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

  get messages(): SessionStoreSnapshot["messages"] {
    this.#subscribe();
    return this.#snapshot.messages;
  }
  get agents(): SessionStoreSnapshot["agents"] {
    this.#subscribe();
    return this.#snapshot.agents;
  }

  get view(): SessionStoreSnapshot["view"] {
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

  follow = (receipt: Pick<Delivery, "sessionId" | "deliveryId">): void => {
    this.#store.follow(receipt);
  };

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
 * The conversation's `messages`, `agents`, and `view` are exposed
 * directly; derive anything else from `events`.
 * Configuration is read once; create a new binding to change base URL or session.
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
  if ("window" in globalThis)
    onMount(() => {
      attachSessionStore(store);
      if (options.resume) void store.resume().catch(() => {});
      return () => detachSessionStore(store);
    });

  return new SvelteEveAgent(store);
}
