import { Client } from "#client/client.js";
import {
  EveAgentPendingSubmissions,
  type EveAgentPendingSubmission,
} from "#client/eve-agent-pending-submissions.js";
import {
  type ActiveTurn,
  assertExclusiveTurnInput,
  createAbortSignal,
  createActiveTurn,
  createSubmissionId,
  isAbortError,
  summarizeUserContent,
  toTerminalStreamFailureError,
} from "#client/eve-agent-store-helpers.js";
import type { EveAgentReducer, EveAgentReducerEvent } from "#client/reducer.js";
import type { ClientSession } from "#client/session.js";
import { createEventDeduper } from "#protocol/event-dedupe.js";
import { isCurrentTurnBoundaryEvent, type MessageStreamEvent } from "#protocol/message.js";
import { toError } from "#shared/errors.js";
import type {
  CancelSessionResult,
  ClientAuth,
  HeadersValue,
  SendTurnPayload,
  ClientSessionState,
  StreamReconnectPolicy,
} from "#client/types.js";

export type {
  EveAgentPendingSubmission,
  EveAgentPendingSubmissionStatus,
} from "#client/eve-agent-pending-submissions.js";

/**
 * Lifecycle state of an {@link EveAgentStore}: `ready` (idle), `submitted`
 * (turn sent, awaiting the first event), `streaming` (events arriving), and
 * `error` (the turn failed). A turn advances `ready` to `submitted` to
 * `streaming` to `ready` (or `error`).
 */
export type EveAgentStoreStatus = "error" | "ready" | "streaming" | "submitted";

/**
 * Prepares one outbound turn immediately before the client sends it, e.g. to
 * attach fresh one-turn client state such as page context via `clientContext`.
 */
export type PrepareSend = (input: SendTurnPayload) => SendTurnPayload | Promise<SendTurnPayload>;

/**
 * Immutable projected state of an {@link EveAgentStore}, read on every render.
 *
 * `data` is the reducer output, `events` is the raw server stream-event log for
 * this session, `pendingSubmissions` is the browser-local projection of
 * overlapping message sends, `session` is the current serializable cursor,
 * `status` is the turn lifecycle state, and `error` is the last failure (or
 * `undefined`).
 */
export interface EveAgentStoreSnapshot<TData> {
  readonly data: TData;
  readonly error: Error | undefined;
  readonly events: readonly MessageStreamEvent[];
  readonly pendingSubmissions: readonly EveAgentPendingSubmission[];
  readonly session: ClientSessionState | undefined;
  readonly status: EveAgentStoreStatus;
}

/**
 * Hooks invoked while the store processes a turn.
 *
 * `onEvent`, `onError`, `onFinish`, and `onSessionChange` are observe-only.
 * `prepareSend` runs before each turn is sent and may return a modified
 * {@link SendTurnPayload} (for example to attach one-turn client context).
 */
export interface EveAgentStoreCallbacks<TData> {
  readonly onError?: (error: Error) => void;
  readonly onEvent?: (event: MessageStreamEvent) => void;
  readonly onFinish?: (snapshot: EveAgentStoreSnapshot<TData>) => void;
  readonly onSessionChange?: (session: ClientSessionState | undefined) => void;
  readonly prepareSend?: PrepareSend;
}

/**
 * Configuration for constructing an {@link EveAgentStore}.
 *
 * Requires a {@link EveAgentReducer | reducer}, plus either connection options
 * (`host`, `auth`, `headers`, `initialSession`) for a
 * store-owned session or an existing {@link ClientSession} via `session`.
 *
 * `optimistic` (default `true`) projects submitted user messages before the
 * server confirms them. `host` defaults to `""`. `initialEvents` and
 * `initialSession` seed prior state on construction. Passing `session` makes
 * `reset()` reuse that external session rather than create a new one.
 * `initialEvents` must be an ordered prefix of the same session's stream; its
 * endpoint may overlap the cursor because repeated ids are applied once.
 */
export interface EveAgentStoreInit<TData> {
  readonly auth?: ClientAuth;
  readonly headers?: HeadersValue;
  readonly host?: string;
  /** Ordered prefix of the session stream used to rehydrate projected state. */
  readonly initialEvents?: readonly MessageStreamEvent[];
  readonly initialSession?: ClientSessionState;
  readonly optimistic?: boolean;
  readonly reducer: EveAgentReducer<TData>;
  readonly session?: ClientSession;
}

interface PendingMessageSubmission {
  readonly createdAt: number;
  readonly id: string;
  readonly message: string;
}

interface SessionBootstrap {
  readonly ownerSubmissionId: string;
  readonly promise: Promise<ClientSession>;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (session: ClientSession) => void;
}

interface SessionFollower {
  readonly abortController: AbortController;
  readonly generation: number;
}

const detachStore = Symbol("detachEveAgentStore");

/**
 * Framework-agnostic state machine for an eve agent session.
 *
 * Manages the send/stream lifecycle, optimistic projection, and subscriber
 * notification; framework integrations (React, Vue) wrap it with their own
 * reactivity primitives.
 *
 * Owns one session stream while message deliveries remain independent. An
 * overlapping message requires an explicit `turnPolicy`; input responses stay
 * serialized. Read the latest projection via the `snapshot` getter, observe
 * changes with `subscribe`, register lifecycle hooks with `setCallbacks`,
 * cancel the active durable turn with `cancel`, and discard all state with
 * `reset`.
 */
export class EveAgentStore<TData> {
  readonly #client: Client | undefined;
  readonly #externalSession: boolean;
  readonly #optimistic: boolean;
  readonly #reducer: EveAgentReducer<TData>;
  readonly #subscribers = new Set<() => void>();

  /** Ids already folded into the projection: `initialEvents` and a reconnect can overlap. */
  #seenEvents = createEventDeduper();

  #activeTurn: ActiveTurn | undefined;
  #callbacks: EveAgentStoreCallbacks<TData> = {};
  #awaitingPrimaryMessage = false;
  #data: TData;
  #error: Error | undefined;
  #events: readonly MessageStreamEvent[];
  #generation = 0;
  #pendingMessageSubmission: PendingMessageSubmission | undefined;
  readonly #pendingSubmissions = new EveAgentPendingSubmissions();
  #projectionEvents: readonly EveAgentReducerEvent[];
  #session: ClientSession | undefined;
  #sessionBootstrap: SessionBootstrap | undefined;
  #sessionFollower: SessionFollower | undefined;
  #snapshot: EveAgentStoreSnapshot<TData>;
  #status: EveAgentStoreStatus = "ready";
  #transportAbortController = new AbortController();

  constructor(init: EveAgentStoreInit<TData>) {
    this.#externalSession = init.session !== undefined;
    this.#client = this.#externalSession
      ? undefined
      : new Client({
          auth: init.auth,
          headers: init.headers,
          host: init.host ?? "",
        });
    // Seed the deduper from the saved log so a live stream that replays the
    // same prefix does not double-apply it.
    const initialEvents: MessageStreamEvent[] = [];
    for (const event of init.initialEvents ?? []) {
      if (this.#seenEvents.admit(event)) initialEvents.push(event);
    }
    this.#events = initialEvents;
    this.#projectionEvents = [...this.#events];
    this.#optimistic = init.optimistic ?? true;
    this.#reducer = init.reducer;
    this.#session =
      init.session ??
      (init.initialSession === undefined
        ? undefined
        : this.#client?.sessions.attach(init.initialSession.sessionId, {
            streamIndex: init.initialSession.streamIndex,
          }));

    this.#data = this.#reduceProjectionEvents(this.#projectionEvents);
    this.#snapshot = this.#createSnapshot();
  }

  get snapshot(): EveAgentStoreSnapshot<TData> {
    return this.#snapshot;
  }

  setCallbacks(callbacks: EveAgentStoreCallbacks<TData>): void {
    this.#callbacks = callbacks;
  }

  subscribe(callback: () => void): () => void {
    this.#subscribers.add(callback);
    return () => {
      this.#subscribers.delete(callback);
    };
  }

  async send<TOutput = unknown>(input: SendTurnPayload<TOutput>): Promise<void> {
    const generation = this.#generation;
    const submissionId = createSubmissionId();
    const overlapping = this.#status === "streaming" || this.#status === "submitted";
    if (overlapping && input.inputResponses !== undefined) {
      throw new Error("eve session is already processing a turn.");
    }
    if (overlapping && input.message !== undefined && input.turnPolicy === undefined) {
      throw new Error(
        "Sending while an eve turn is active requires turnPolicy to be 'queue' or 'steer'.",
      );
    }
    if (!overlapping) {
      this.#activeTurn = createActiveTurn();
      this.#error = undefined;
      this.#status = "submitted";
      this.#publish();
    }
    const ownsBootstrap = this.#reserveSessionBootstrap(submissionId);

    try {
      const preparedInput = (await this.#callbacks.prepareSend?.(input)) ?? input;
      assertExclusiveTurnInput(preparedInput);

      if (!this.#isCurrentGeneration(generation)) return;

      if (overlapping) {
        if (preparedInput.inputResponses !== undefined || preparedInput.turnPolicy === undefined) {
          throw new Error("prepareSend cannot remove the active message's turnPolicy.");
        }
        this.#pendingSubmissions.append(
          {
            id: submissionId,
            message: summarizeUserContent(preparedInput.message),
            status: "submitting",
            turnPolicy: preparedInput.turnPolicy,
          },
          preparedInput.message,
        );
      } else {
        this.#awaitingPrimaryMessage = preparedInput.message !== undefined;
        this.#projectOptimisticMessage(preparedInput);
        this.#projectInputResponses(preparedInput);
      }
      this.#publish();

      await this.#dispatchSubmission({
        generation,
        input: {
          ...preparedInput,
          signal: createAbortSignal(preparedInput.signal, this.#transportAbortController.signal),
        },
        ownsBootstrap,
        submissionId,
      });

      if (!this.#isCurrentGeneration(generation)) return;
      if (overlapping && preparedInput.message !== undefined) {
        this.#pendingSubmissions.update(submissionId, {
          status: preparedInput.turnPolicy === "queue" ? "queued" : "steering",
        });
        this.#publish();
      }
    } catch (error) {
      if (!this.#isCurrentGeneration(generation)) return;

      const normalized = toError(error);
      if (!overlapping && isAbortError(normalized)) {
        this.#status = "ready";
        this.#awaitingPrimaryMessage = false;
        this.#settleActiveTurn();
        this.#failPendingMessageSubmission(normalized);
        this.#rejectSessionBootstrap(submissionId, normalized);
        this.#publish();
        this.#callbacks.onFinish?.(this.#snapshot);
        return;
      }
      if (overlapping) {
        this.#pendingSubmissions.update(submissionId, { error: normalized, status: "failed" });
      } else {
        this.#error = normalized;
        this.#status = "error";
        this.#awaitingPrimaryMessage = false;
        this.#settleActiveTurn();
        this.#failPendingMessageSubmission(normalized);
        this.#callbacks.onFinish?.(this.#createSnapshot());
      }
      this.#callbacks.onError?.(normalized);
      this.#rejectSessionBootstrap(submissionId, normalized);
      this.#publish();
    }
  }

  /** Requests cooperative cancellation of the active durable turn. */
  cancel(): Promise<CancelSessionResult> {
    const turn = this.#activeTurn;
    if (turn === undefined || turn.settled) {
      return Promise.resolve({ status: "no_active_turn" });
    }
    if (turn.cancellation !== undefined) return turn.cancellation;

    const cancellation = turn.turnId.then<CancelSessionResult>(async (turnId) => {
      const session = this.#session;
      if (turnId === undefined || session === undefined) {
        return { status: "no_active_turn" };
      }
      return await session.cancel({ turnId });
    });
    turn.cancellation = cancellation;
    void cancellation.catch(() => {
      if (!turn.settled && turn.cancellation === cancellation) {
        turn.cancellation = undefined;
      }
    });
    return cancellation;
  }

  [detachStore](): void {
    this.#generation += 1;
    this.#transportAbortController.abort();
    this.#sessionFollower?.abortController.abort();
    this.#sessionFollower = undefined;
    this.#rejectSessionBootstrap(
      undefined,
      new DOMException("The operation was aborted.", "AbortError"),
    );
    this.#settleActiveTurn();
  }

  reset(): void {
    this[detachStore]();
    this.#transportAbortController = new AbortController();
    if (!this.#externalSession) this.#session = undefined;
    this.#events = [];
    this.#seenEvents = createEventDeduper();
    this.#awaitingPrimaryMessage = false;
    this.#pendingMessageSubmission = undefined;
    this.#pendingSubmissions.clear();
    this.#projectionEvents = [];
    this.#data = this.#reducer.initial();
    this.#error = undefined;
    this.#status = "ready";
    this.#callbacks.onSessionChange?.(this.#session?.state);
    this.#publish();
  }

  async #createFirstTurn<TOutput>(input: SendTurnPayload<TOutput>): Promise<ClientSession> {
    if (this.#client === undefined) {
      throw new Error("An external eve session is required before sending.");
    }
    if (input.message === undefined) {
      throw new Error("Cannot answer an input request before the session starts.");
    }
    const created = await this.#client.sessions.create({ ...input, message: input.message });
    this.#session = created.session;
    this.#callbacks.onSessionChange?.(created.session.state);
    this.#publish();
    return created.session;
  }

  async #dispatchSubmission<TOutput>(args: {
    readonly generation: number;
    readonly input: SendTurnPayload<TOutput>;
    readonly ownsBootstrap: boolean;
    readonly submissionId: string;
  }): Promise<void> {
    let session = this.#session;
    if (args.ownsBootstrap) {
      session = await this.#createFirstTurn(args.input);
      if (!this.#isCurrentGeneration(args.generation)) return;
      this.#resolveSessionBootstrap(args.submissionId, session);
      this.#ensureSessionFollower(session, args.input.streamReconnectPolicy);
      return;
    }

    session ??= await this.#requireSessionBootstrap().promise;
    if (!this.#isCurrentGeneration(args.generation)) return;

    const input = args.input;
    if (input.inputResponses === undefined) {
      const { message, ...options } = input;
      await session.send(message, options);
      this.#ensureSessionFollower(session, input.streamReconnectPolicy);
      return;
    }
    const { inputResponses, ...options } = input;
    await session.respond(inputResponses, options);
    this.#ensureSessionFollower(session, input.streamReconnectPolicy);
  }

  #reserveSessionBootstrap(submissionId: string): boolean {
    if (this.#session !== undefined || this.#sessionBootstrap !== undefined) return false;
    const deferred = Promise.withResolvers<ClientSession>();
    void deferred.promise.catch(() => {});
    this.#sessionBootstrap = {
      ownerSubmissionId: submissionId,
      ...deferred,
    };
    return true;
  }

  #requireSessionBootstrap(): SessionBootstrap {
    const bootstrap = this.#sessionBootstrap;
    if (bootstrap === undefined) {
      throw new Error("An eve session was not available for the message delivery.");
    }
    return bootstrap;
  }

  #resolveSessionBootstrap(submissionId: string, session: ClientSession): void {
    const bootstrap = this.#sessionBootstrap;
    if (bootstrap?.ownerSubmissionId !== submissionId) return;
    this.#sessionBootstrap = undefined;
    bootstrap.resolve(session);
  }

  #rejectSessionBootstrap(submissionId: string | undefined, error: Error): void {
    const bootstrap = this.#sessionBootstrap;
    if (
      bootstrap === undefined ||
      (submissionId !== undefined && bootstrap.ownerSubmissionId !== submissionId)
    ) {
      return;
    }
    this.#sessionBootstrap = undefined;
    bootstrap.reject(error);
  }

  #isCurrentGeneration(generation: number): boolean {
    return this.#generation === generation;
  }

  #ensureSessionFollower(
    session: ClientSession,
    streamReconnectPolicy?: StreamReconnectPolicy,
  ): void {
    if (this.#sessionFollower !== undefined) return;
    const follower: SessionFollower = {
      abortController: new AbortController(),
      generation: this.#generation,
    };
    this.#sessionFollower = follower;
    void this.#followSession(session, follower, streamReconnectPolicy);
  }

  async #followSession(
    session: ClientSession,
    follower: SessionFollower,
    streamReconnectPolicy: StreamReconnectPolicy | undefined,
  ): Promise<void> {
    try {
      for await (const event of session.stream({
        signal: follower.abortController.signal,
        streamReconnectPolicy,
      })) {
        if (this.#sessionFollower !== follower || !this.#isCurrentGeneration(follower.generation)) {
          return;
        }
        if (!this.#seenEvents.admit(event)) continue;

        this.#observeTurnLifecycle(event);
        this.#events = [...this.#events, event];
        this.#applyServerEvent(event);
        this.#callbacks.onEvent?.(event);
        this.#applyTerminalStreamFailure(event);
        this.#publish();

        if (isCurrentTurnBoundaryEvent(event)) {
          this.#callbacks.onSessionChange?.(session.state);
          this.#callbacks.onFinish?.(this.#snapshot);
        }
      }
    } catch (error) {
      if (!follower.abortController.signal.aborted && this.#sessionFollower === follower) {
        const normalized = toError(error);
        this.#settleActiveTurn();
        this.#error = normalized;
        this.#status = "error";
        this.#callbacks.onError?.(normalized);
        this.#callbacks.onSessionChange?.(session.state);
        this.#publish();
        this.#callbacks.onFinish?.(this.#snapshot);
      }
    } finally {
      if (this.#sessionFollower === follower) this.#sessionFollower = undefined;
    }
  }

  #observeTurnLifecycle(event: MessageStreamEvent): void {
    if (event.type === "turn.started") {
      this.#activeTurn ??= createActiveTurn();
      this.#activeTurn.resolveTurnId(event.data.turnId);
      this.#pendingSubmissions.captureTurn(this.#awaitingPrimaryMessage);
      this.#status = "streaming";
      return;
    }

    if (!isCurrentTurnBoundaryEvent(event)) {
      if (this.#status === "submitted") this.#status = "streaming";
      return;
    }

    this.#pendingSubmissions.clearTurn();
    this.#awaitingPrimaryMessage = false;
    this.#settleActiveTurn();
    if (event.type === "session.failed") {
      this.#status = "error";
      return;
    }
    if (this.#pendingSubmissions.hasWork) {
      this.#activeTurn = createActiveTurn();
      this.#status = "submitted";
    } else {
      this.#status = "ready";
    }
  }

  #settleActiveTurn(): void {
    const turn = this.#activeTurn;
    if (turn === undefined) return;
    turn.settled = true;
    turn.resolveTurnId(undefined);
    this.#activeTurn = undefined;
  }

  #projectOptimisticMessage(input: SendTurnPayload): void {
    if (!this.#optimistic || input.message === undefined) {
      return;
    }

    const id = createSubmissionId();
    const pending = {
      createdAt: Date.now(),
      id,
      message: summarizeUserContent(input.message),
    };
    this.#pendingMessageSubmission = pending;
    this.#appendProjectionEvent({
      data: {
        createdAt: pending.createdAt,
        message: pending.message,
        submissionId: pending.id,
      },
      type: "client.message.submitted",
    });
  }

  #projectInputResponses(input: SendTurnPayload): void {
    if (input.inputResponses === undefined || input.inputResponses.length === 0) {
      return;
    }

    this.#appendProjectionEvent({
      data: {
        createdAt: Date.now(),
        responses: input.inputResponses,
      },
      type: "client.input.responded",
    });
  }

  #applyServerEvent(event: MessageStreamEvent): void {
    if (event.type === "message.received") {
      const receivedPrimaryMessage = this.#awaitingPrimaryMessage;
      this.#awaitingPrimaryMessage = false;

      if (!receivedPrimaryMessage && this.#pendingSubmissions.hasTurnCandidates) {
        this.#pendingSubmissions.consumeTurn(event.data.message);
      }

      if (this.#pendingMessageSubmission !== undefined) {
        const submissionId = this.#pendingMessageSubmission.id;
        this.#pendingMessageSubmission = undefined;
        this.#replaceProjectionEvent(
          (candidate) =>
            candidate.type === "client.message.submitted" &&
            candidate.data.submissionId === submissionId,
          event,
        );
        return;
      }
    }

    this.#appendProjectionEvent(event);
  }

  #applyTerminalStreamFailure(event: MessageStreamEvent): void {
    const error = toTerminalStreamFailureError(event);
    if (error === undefined) {
      return;
    }

    this.#status = "error";
    this.#failPendingMessageSubmission(error);
    this.#pendingSubmissions.fail(error);

    if (this.#error === undefined) {
      this.#error = error;
      this.#callbacks.onError?.(error);
    }
  }

  #failPendingMessageSubmission(error: Error): void {
    const pending = this.#pendingMessageSubmission;
    if (pending === undefined) {
      return;
    }

    this.#pendingMessageSubmission = undefined;
    this.#replaceProjectionEvent(
      (event) =>
        event.type === "client.message.submitted" && event.data.submissionId === pending.id,
      {
        data: {
          createdAt: pending.createdAt,
          error: {
            message: error.message,
          },
          message: pending.message,
          submissionId: pending.id,
        },
        type: "client.message.failed",
      },
    );
  }

  #appendProjectionEvent(event: EveAgentReducerEvent): void {
    this.#projectionEvents = [...this.#projectionEvents, event];
    this.#data = this.#reducer.reduce(this.#data, event);
  }

  #replaceProjectionEvent(
    predicate: (event: EveAgentReducerEvent) => boolean,
    replacement: EveAgentReducerEvent,
  ): void {
    let replaced = false;
    this.#projectionEvents = this.#projectionEvents.map((event) => {
      if (!replaced && predicate(event)) {
        replaced = true;
        return replacement;
      }
      return event;
    });

    if (!replaced) {
      this.#projectionEvents = [...this.#projectionEvents, replacement];
    }

    this.#data = this.#reduceProjectionEvents(this.#projectionEvents);
  }

  #reduceProjectionEvents(events: readonly EveAgentReducerEvent[]): TData {
    let data = this.#reducer.initial();
    for (const event of events) {
      data = this.#reducer.reduce(data, event);
    }
    return data;
  }

  #createSnapshot(): EveAgentStoreSnapshot<TData> {
    return {
      data: this.#data,
      error: this.#error,
      events: this.#events,
      pendingSubmissions: this.#pendingSubmissions.snapshot,
      session: this.#session?.state,
      status: this.#status,
    };
  }

  #publish(): void {
    this.#snapshot = this.#createSnapshot();
    for (const subscriber of this.#subscribers) {
      subscriber();
    }
  }
}

/** @internal Detaches local transport without cancelling durable server work. */
export function detachEveAgentStore<TData>(store: EveAgentStore<TData>): void {
  store[detachStore]();
}
