import { Client } from "#client/client.js";
import type { MessageResponse } from "#client/message-response.js";
import type { EveAgentReducer, EveAgentReducerEvent } from "#client/reducer.js";
import type { ClientSession } from "#client/session.js";
import { createEventDeduper } from "#protocol/event-dedupe.js";
import { isCurrentTurnBoundaryEvent, type MessageStreamEvent } from "#protocol/message.js";
import {
  assertExclusiveTurnInput,
  collectPendingAuthorizations,
  createAbortSignal,
  createSubmissionId,
  isAbortError,
  isSettledSessionTail,
  summarizeUserContent,
  toTerminalStreamFailureError,
  updatePendingAuthorizations,
} from "#client/eve-agent-store-helpers.js";
import { toError } from "#shared/errors.js";
import type {
  CancelSessionResult,
  ClientAuth,
  HeadersValue,
  SendTurnPayload,
  ClientSessionState,
} from "#client/types.js";

/**
 * Lifecycle state of an {@link EveAgentStore}: `ready` (idle), `resuming`
 * (checking an attached session for continuation), `submitted` (turn sent,
 * awaiting the first event), `streaming` (events arriving), and `error` (the
 * turn failed). A new turn advances `ready` to `submitted` to `streaming` to
 * `ready` (or `error`).
 */
export type EveAgentStoreStatus = "error" | "ready" | "resuming" | "streaming" | "submitted";

/**
 * Prepares one outbound turn immediately before the client sends it, e.g. to
 * attach fresh one-turn client state such as page context via `clientContext`.
 */
export type PrepareSend = (input: SendTurnPayload) => SendTurnPayload | Promise<SendTurnPayload>;

/**
 * Immutable projected state of an {@link EveAgentStore}, read on every render.
 *
 * `data` is the reducer output, `events` is the raw server stream-event log for
 * this session, `session` is the current serializable cursor, `status` is the
 * turn lifecycle state, and `error` is the last failure (or `undefined`).
 */
export interface EveAgentStoreSnapshot<TData> {
  readonly data: TData;
  readonly error: Error | undefined;
  readonly events: readonly MessageStreamEvent[];
  readonly session: ClientSessionState | undefined;
  readonly status: EveAgentStoreStatus;
}

/**
 * Hooks invoked while the store processes a turn.
 *
 * `onEvent`, `onError`, `onFinish`, and `onSessionChange` are observe-only.
 * `prepareSend` runs before each turn is sent and may return a modified
 * {@link SendTurnPayload} (for example to attach client context).
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

const detachStore = Symbol("detachEveAgentStore");

interface ActiveTurn {
  readonly abortController: AbortController;
  acceptedFollowUps: number;
  readonly cancel: () => Promise<CancelSessionResult>;
  readonly completion: Promise<void>;
  readonly followUpDispatches: Set<Promise<void>>;
  receivedFollowUps: number;
  readonly resolveCompletion: () => void;
  readonly response: Promise<MessageResponse | undefined>;
  readonly resolveResponse: (response: MessageResponse | undefined) => void;
}

/**
 * Framework-agnostic state machine for an eve agent session.
 *
 * Manages the send/stream lifecycle, optimistic projection, and subscriber
 * notification; framework integrations (React, Vue) wrap it with their own
 * reactivity primitives.
 *
 * Drives one turn at a time: `send` rejects while a turn is active, and
 * concurrent `resume` calls share one replay. Read the latest projection via
 * the `snapshot` getter, observe changes with `subscribe`, register lifecycle
 * hooks with `setCallbacks`, cancel the durable in-flight turn with `cancel`,
 * and discard all state with `reset`.
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
  #data: TData;
  #error: Error | undefined;
  #events: readonly MessageStreamEvent[];
  #pendingMessageSubmissions: readonly PendingMessageSubmission[] = [];
  #projectionEvents: readonly EveAgentReducerEvent[];
  #resumePromise: Promise<void> | undefined;
  #session: ClientSession | undefined;
  #snapshot: EveAgentStoreSnapshot<TData>;
  #status: EveAgentStoreStatus = "ready";

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
    if (this.#activeTurn !== undefined) {
      if (this.#status === "resuming") {
        throw new Error("eve session is resuming.");
      }
      return await this.#sendFollowUp(this.#activeTurn, input);
    }

    const response = Promise.withResolvers<MessageResponse | undefined>();
    const completion = Promise.withResolvers<void>();
    const turn: ActiveTurn = {
      abortController: new AbortController(),
      acceptedFollowUps: 0,
      cancel: () =>
        turn.acceptedFollowUps > 0 && this.#session !== undefined
          ? this.#session.cancel()
          : response.promise.then((messageResponse) =>
              messageResponse === undefined
                ? { status: "no_active_turn" }
                : messageResponse.cancel(),
            ),
      completion: completion.promise,
      followUpDispatches: new Set(),
      receivedFollowUps: 0,
      resolveCompletion: completion.resolve,
      response: response.promise,
      resolveResponse: response.resolve,
    };
    this.#activeTurn = turn;
    this.#error = undefined;
    this.#status = "submitted";
    this.#publish();

    try {
      const preparedInput = (await this.#callbacks.prepareSend?.(input)) ?? input;
      assertExclusiveTurnInput(preparedInput);

      if (!this.#isActiveTurn(turn)) {
        return;
      }

      this.#projectOptimisticMessage(preparedInput);
      this.#projectInputResponses(preparedInput);
      this.#publish();

      const turnInput = {
        ...preparedInput,
        signal: createAbortSignal(preparedInput.signal, turn.abortController.signal),
      };
      const response = await this.#dispatchTurn(turnInput);

      if (!this.#isActiveTurn(turn)) return;
      turn.resolveResponse(response);

      for await (const event of response) {
        if (!this.#isActiveTurn(turn)) return;
        this.#acceptServerEvent(event);
      }

      if (!this.#isActiveTurn(turn)) {
        return;
      }

      await this.#followSteeredTurns(turn);
      if (!this.#isActiveTurn(turn)) return;
      this.#status = this.#error === undefined ? "ready" : "error";
    } catch (error) {
      if (!this.#isActiveTurn(turn)) {
        return;
      }

      if (isAbortError(error)) {
        this.#status = "ready";
        this.#failPendingMessageSubmission(toError(error));
      } else {
        this.#error = toError(error);
        this.#status = "error";
        this.#failPendingMessageSubmission(this.#error);
        this.#callbacks.onError?.(this.#error);
      }
    } finally {
      if (this.#isActiveTurn(turn)) {
        turn.resolveResponse(undefined);
        this.#activeTurn = undefined;
        this.#callbacks.onSessionChange?.(this.#session?.state);
        this.#publish();
        this.#callbacks.onFinish?.(this.#snapshot);
        turn.resolveCompletion();
      }
    }
  }

  /** Replays this store's attached durable session and follows an in-flight turn. */
  resume(): Promise<void> {
    if (this.#resumePromise !== undefined) return this.#resumePromise;

    const promise = this.#resume();
    this.#resumePromise = promise;
    const clear = () => {
      if (this.#resumePromise === promise) this.#resumePromise = undefined;
    };
    void promise.then(clear, clear);
    return promise;
  }

  async #resume(): Promise<void> {
    if (
      this.#status === "resuming" ||
      this.#status === "streaming" ||
      this.#status === "submitted"
    ) {
      throw new Error("eve session is already processing a turn.");
    }
    if (this.#session === undefined) {
      throw new Error("An eve session is required before resuming.");
    }

    const response = Promise.withResolvers<MessageResponse | undefined>();
    const completion = Promise.withResolvers<void>();
    const session = this.#session;
    const turn: ActiveTurn = {
      abortController: new AbortController(),
      acceptedFollowUps: 0,
      cancel: () => session.cancel(),
      completion: completion.promise,
      followUpDispatches: new Set(),
      receivedFollowUps: 0,
      resolveCompletion: completion.resolve,
      response: response.promise,
      resolveResponse: response.resolve,
    };
    this.#activeTurn = turn;
    turn.resolveResponse(undefined);
    this.#error = undefined;
    this.#status = "resuming";
    this.#publish();

    try {
      const hasCompleteInitialPrefix = this.#events.length === session.state.streamIndex;
      const replayed: MessageStreamEvent[] = hasCompleteInitialPrefix ? [...this.#events] : [];
      for await (const event of session.stream({
        follow: false,
        signal: turn.abortController.signal,
        startIndex: hasCompleteInitialPrefix ? session.state.streamIndex : 0,
      })) {
        if (!this.#isActiveTurn(turn)) return;
        replayed.push(event);
        this.#acceptServerEvent(event, { publish: false, transitionToStreaming: false });
      }

      if (!this.#isActiveTurn(turn)) return;
      const replayTail = replayed.at(-1);
      if (replayTail !== undefined) this.#applyTerminalStreamFailure(replayTail);
      const replaySettled = isSettledSessionTail(replayed);
      if (this.#error === undefined && (!replaySettled || replayTail?.type === "session.waiting")) {
        const pendingAuthorizations = collectPendingAuthorizations(replayed);
        if (!replaySettled) this.#status = "streaming";
        this.#publish();
        for await (const event of session.stream({
          signal: turn.abortController.signal,
          streamReconnectPolicy: replaySettled ? { reconnect: false } : undefined,
        })) {
          if (!this.#isActiveTurn(turn)) return;
          this.#acceptServerEvent(event);
          updatePendingAuthorizations(pendingAuthorizations, event);
          if (
            isCurrentTurnBoundaryEvent(event) &&
            (event.type !== "session.waiting" || pendingAuthorizations.size === 0)
          ) {
            break;
          }
        }
      } else {
        this.#status = this.#error === undefined ? "ready" : "error";
        this.#publish();
      }

      await this.#followSteeredTurns(turn);
      if (this.#isActiveTurn(turn)) {
        this.#status = this.#error === undefined ? "ready" : "error";
      }
    } catch (error) {
      if (!this.#isActiveTurn(turn)) return;
      if (isAbortError(error)) {
        this.#status = "ready";
      } else {
        this.#error = toError(error);
        this.#status = "error";
        this.#callbacks.onError?.(this.#error);
      }
    } finally {
      if (this.#isActiveTurn(turn)) {
        turn.resolveResponse(undefined);
        this.#activeTurn = undefined;
        this.#callbacks.onSessionChange?.(session.state);
        this.#publish();
        this.#callbacks.onFinish?.(this.#snapshot);
        turn.resolveCompletion();
      }
    }
  }

  /**
   * Requests cooperative cancellation of the active durable turn.
   *
   * If the server has not emitted `turn.started` yet, the request waits for
   * that turn ID. The event stream stays attached until the turn settles.
   */
  cancel(): Promise<CancelSessionResult> {
    const turn = this.#activeTurn;
    if (turn === undefined) return Promise.resolve({ status: "no_active_turn" });
    return turn.cancel();
  }

  [detachStore](): void {
    this.#activeTurn?.abortController.abort();
  }

  reset(): void {
    const turn = this.#activeTurn;
    this.#activeTurn = undefined;
    turn?.resolveResponse(undefined);
    turn?.resolveCompletion();
    turn?.abortController.abort();
    if (!this.#externalSession) this.#session = undefined;
    this.#events = [];
    this.#seenEvents = createEventDeduper();
    this.#pendingMessageSubmissions = [];
    this.#projectionEvents = [];
    this.#data = this.#reducer.initial();
    this.#error = undefined;
    this.#status = "ready";
    this.#callbacks.onSessionChange?.(this.#session?.state);
    this.#publish();
  }

  async #sendFollowUp<TOutput>(turn: ActiveTurn, input: SendTurnPayload<TOutput>): Promise<void> {
    if (input.message === undefined || input.turnPolicy !== "steer") {
      throw new Error(
        'eve session is already processing a turn. Send a message with turnPolicy: "steer" to replace it.',
      );
    }

    const preparedInput = (await this.#callbacks.prepareSend?.(input)) ?? input;
    assertExclusiveTurnInput(preparedInput);
    if (preparedInput.message === undefined || preparedInput.turnPolicy !== "steer") {
      throw new Error('An in-flight follow-up requires a message with turnPolicy: "steer".');
    }
    if (!this.#isActiveTurn(turn)) return await this.send(preparedInput);

    const submissionId = this.#projectOptimisticMessage(preparedInput);
    this.#publish();

    let dispatch!: Promise<void>;
    dispatch = (async () => {
      try {
        await turn.response;
        if (!this.#isActiveTurn(turn) || this.#session === undefined) {
          throw new Error("The active eve turn ended before the follow-up could be sent.");
        }
        const { message, ...options } = preparedInput;
        await this.#session.send(message, options);
        turn.acceptedFollowUps += 1;
      } catch (error) {
        this.#failPendingMessageSubmission(toError(error), submissionId);
        this.#publish();
        throw error;
      } finally {
        turn.followUpDispatches.delete(dispatch);
      }
    })();
    turn.followUpDispatches.add(dispatch);

    await dispatch;
    await turn.completion;
  }

  async #followSteeredTurns(turn: ActiveTurn): Promise<void> {
    while (turn.followUpDispatches.size > 0) {
      await Promise.allSettled(turn.followUpDispatches);
    }
    if (turn.receivedFollowUps >= turn.acceptedFollowUps || this.#session === undefined) return;

    for await (const event of this.#session.stream({ signal: turn.abortController.signal })) {
      if (!this.#isActiveTurn(turn)) return;
      if (event.type === "message.received") turn.receivedFollowUps += 1;
      this.#acceptServerEvent(event);

      if (isCurrentTurnBoundaryEvent(event)) {
        while (turn.followUpDispatches.size > 0) {
          await Promise.allSettled(turn.followUpDispatches);
        }
        if (turn.receivedFollowUps >= turn.acceptedFollowUps) return;
      }
    }
  }

  async #createFirstTurn<TOutput>(
    input: SendTurnPayload<TOutput>,
  ): Promise<Awaited<ReturnType<ClientSession["send"]>>> {
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
    return created.response;
  }

  async #dispatchTurn<TOutput>(
    input: SendTurnPayload<TOutput>,
  ): Promise<Awaited<ReturnType<ClientSession["send"]>>> {
    if (this.#session === undefined) return await this.#createFirstTurn(input);
    if (input.inputResponses === undefined) {
      const { message, ...options } = input;
      return await this.#session.send(message, options);
    }
    const { inputResponses, ...options } = input;
    return await this.#session.respond(inputResponses, options);
  }

  #isActiveTurn(turn: ActiveTurn): boolean {
    return this.#activeTurn === turn;
  }

  #projectOptimisticMessage(input: SendTurnPayload): string | undefined {
    if (!this.#optimistic || input.message === undefined) {
      return undefined;
    }

    const id = createSubmissionId();
    const pending = {
      createdAt: Date.now(),
      id,
      message: summarizeUserContent(input.message),
    };
    this.#pendingMessageSubmissions = [...this.#pendingMessageSubmissions, pending];
    this.#appendProjectionEvent({
      data: {
        createdAt: pending.createdAt,
        message: pending.message,
        submissionId: pending.id,
      },
      type: "client.message.submitted",
    });
    return id;
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

  #acceptServerEvent(
    event: MessageStreamEvent,
    options: { readonly publish?: boolean; readonly transitionToStreaming?: boolean } = {},
  ): void {
    if (!this.#seenEvents.admit(event)) return;
    this.#events = [...this.#events, event];
    this.#applyServerEvent(event);
    this.#callbacks.onEvent?.(event);
    if (options.transitionToStreaming ?? true) this.#status = "streaming";
    this.#applyTerminalStreamFailure(event);
    if (options.publish ?? true) this.#publish();
  }

  #applyServerEvent(event: MessageStreamEvent): void {
    const pendingSubmission = this.#pendingMessageSubmissions[0];
    if (event.type === "message.received" && pendingSubmission !== undefined) {
      const submissionId = pendingSubmission.id;
      this.#pendingMessageSubmissions = this.#pendingMessageSubmissions.slice(1);
      this.#replaceProjectionEvent(
        (candidate) =>
          candidate.type === "client.message.submitted" &&
          candidate.data.submissionId === submissionId,
        event,
      );
      return;
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

    if (this.#error === undefined) {
      this.#error = error;
      this.#callbacks.onError?.(error);
    }
  }

  #failPendingMessageSubmission(error: Error, submissionId?: string): void {
    const pending =
      submissionId === undefined
        ? this.#pendingMessageSubmissions[0]
        : this.#pendingMessageSubmissions.find((candidate) => candidate.id === submissionId);
    if (pending === undefined) return;

    this.#pendingMessageSubmissions = this.#pendingMessageSubmissions.filter(
      (candidate) => candidate.id !== pending.id,
    );
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
