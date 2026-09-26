import { Client } from "#client/client.js";
import type {
  ActiveTurn,
  EveAgentStoreCallbacks,
  EveAgentStoreInit,
  EveAgentStoreSnapshot,
  EveAgentStoreStatus,
  PrepareSend,
} from "#client/eve-agent-store-state.js";
import {
  consumeMessageResponse,
  getMessageResponseDeliveryId,
  type MessageResponse,
} from "#client/message-response.js";
import type {
  SessionEventReader,
  SessionEventStream,
  SessionEventStreamOptions,
} from "#client/session-event-stream.js";
import { EveAgentProjection } from "#client/eve-agent-projection.js";
import { OptimisticMessageSubmissions } from "#client/optimistic-message-submissions.js";
import { ConversationClient } from "#client/conversation-client.js";
import type { ClientSession } from "#client/session.js";
import { dispatchSessionTurn } from "#client/session-turn-dispatch.js";
import { isCurrentTurnBoundaryEvent, type MessageStreamEvent } from "#protocol/message.js";
import {
  activeTurnForOptimisticFollowUp,
  assertExclusiveTurnInput,
  countFollowUpDeliveries,
  createAbortSignal,
  createActiveTurn,
  followSteeredTurns,
  isAbortError,
  isSettledSessionTail,
  hasPendingAuthorizations,
  toTerminalStreamFailureError,
  waitWithSignal,
} from "#client/eve-agent-store-helpers.js";
import { toError } from "#shared/errors.js";
import type {
  CancelSessionResult,
  ClearResult,
  CompactResult,
  ResetResult,
  SendTurnPayload,
} from "#client/types.js";

export type {
  EveAgentStoreCallbacks,
  EveAgentStoreInit,
  EveAgentStoreSnapshot,
  EveAgentStoreStatus,
  PrepareSend,
} from "#client/eve-agent-store-state.js";

const detachStore = Symbol("detachEveAgentStore");
const attachStore = Symbol("attachEveAgentStore");

/**
 * Owns frontend session creation, continuous streaming, turn submission, and UI projection.
 * Framework bindings subscribe to snapshots and attach or detach transport with their lifecycle.
 * Reset clears local state; cancellation remains an explicit durable operation.
 */
export class EveAgentStore<TData> {
  readonly #client: Client | undefined;
  readonly #autoPrewarm: boolean;
  #attached = false;
  readonly #conversationClient: ConversationClient<TData>;
  readonly #followChildStreams: boolean;
  readonly #externalSession: boolean;
  readonly #subscribers = new Set<() => void>();
  #activeTurn: ActiveTurn | undefined;
  #callbacks: EveAgentStoreCallbacks<TData> = {};
  #error: Error | undefined;
  #events: readonly MessageStreamEvent[];
  readonly #messageSubmissions: OptimisticMessageSubmissions;
  #prewarmGeneration = 0;
  #prewarmPromise: Promise<void> | undefined;
  #prewarmController: AbortController | undefined;
  #resumePromise: Promise<void> | undefined;
  #session: ClientSession | undefined;
  #snapshot: EveAgentStoreSnapshot<TData>;
  #status: EveAgentStoreStatus = "ready";

  constructor(init: EveAgentStoreInit<TData>) {
    this.#autoPrewarm = init.prewarm ?? false;
    this.#followChildStreams = init.followSubagents ?? false;
    this.#externalSession = init.session !== undefined;
    this.#client = this.#externalSession
      ? undefined
      : (init.client ??
        new Client({
          auth: init.auth,
          headers: init.headers,
          host: init.host ?? "",
        }));
    this.#conversationClient = new ConversationClient(
      new EveAgentProjection(init.reducer, []),
      () => this.#publish(),
      () => this.#publish(),
    );
    this.#events = (init.initialEvents ?? []).filter((event) =>
      this.#conversationClient.hydrate(event),
    );
    this.#messageSubmissions = new OptimisticMessageSubmissions(
      this.#conversationClient.projections,
      init.optimistic ?? true,
    );
    this.#session =
      init.session ??
      (init.initialSession === undefined
        ? undefined
        : this.#client?.sessions.attach(init.initialSession.sessionId, {
            streamIndex: init.initialSession.streamIndex,
          }));

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

  /** Creates this store's owned session without starting a turn. */
  prewarm(): Promise<void> {
    if (this.#prewarmPromise !== undefined) return this.#prewarmPromise;
    if (this.#session !== undefined || this.#externalSession) return Promise.resolve();
    if (this.#activeTurn !== undefined) {
      return this.#activeTurn.response.then((response) => {
        if (response === undefined) {
          throw this.#error ?? new DOMException("Session creation was aborted.", "AbortError");
        }
      });
    }
    const client = this.#client;
    if (client === undefined) {
      return Promise.reject(new Error("This eve agent store does not own a session client."));
    }

    const generation = this.#prewarmGeneration;
    const controller = new AbortController();
    this.#prewarmController = controller;
    const promise = (async () => {
      try {
        const created = await client.sessions.create({ signal: controller.signal });
        if (generation !== this.#prewarmGeneration) return;
        this.#error = undefined;
        if (this.#status === "error") this.#status = "ready";
        this.#adoptSession(created.session);
        this.#ensureStream();
      } catch (error) {
        if (
          generation === this.#prewarmGeneration &&
          this.#activeTurn === undefined &&
          this.#error === undefined
        ) {
          this.#fail(error);
        }
        throw error;
      }
    })();
    this.#prewarmPromise = promise;
    const clear = () => {
      if (this.#prewarmPromise === promise) {
        this.#prewarmPromise = undefined;
        this.#prewarmController = undefined;
      }
    };
    void promise.then(clear, clear);
    return promise;
  }

  async send<TOutput = unknown>(input: SendTurnPayload<TOutput>): Promise<void> {
    return await this.#submit(input, this.#callbacks.prepareSend);
  }

  async #submit<TOutput>(
    input: SendTurnPayload<TOutput>,
    prepareSend?: PrepareSend,
  ): Promise<void> {
    if (this.#activeTurn !== undefined) {
      if (this.#status === "resuming") {
        throw new Error("eve session is resuming.");
      }
      return await this.#sendFollowUp(this.#activeTurn, input, prepareSend);
    }

    const turn = createActiveTurn((turn) =>
      turn.acceptedFollowUps > 0 && this.#session !== undefined
        ? this.#session.cancel()
        : turn.response.then((response) =>
            response === undefined ? { status: "no_active_turn" } : response.cancel(),
          ),
    );
    this.#activeTurn = turn;
    this.#error = undefined;
    this.#status = "submitted";

    let reader: SessionEventReader | undefined;
    let submissionId: string | undefined;
    try {
      assertExclusiveTurnInput(input);
      // Echo the submission before preparation, which may wait on caller-owned work.
      submissionId = this.#messageSubmissions.submit(input, this.#events.length);
      this.#projectInputResponses(input);
      this.#publish();
      const preparedInput = await (prepareSend === undefined
        ? input
        : waitWithSignal(
            Promise.resolve(prepareSend(input)),
            createAbortSignal(input.signal, turn.abortController.signal),
          ));
      assertExclusiveTurnInput(preparedInput);

      if (!this.#isActiveTurn(turn)) return;

      const turnInput = {
        ...preparedInput,
        signal: createAbortSignal(preparedInput.signal, turn.abortController.signal),
      };
      const dispatched = await this.#dispatchTurn(turnInput);
      const response = dispatched.response;
      reader = dispatched.reader;

      if (!this.#isActiveTurn(turn)) return;
      turn.resolveResponse(response);

      if (
        this.#handleReconciliation(
          this.#messageSubmissions.correlate(
            submissionId,
            getMessageResponseDeliveryId(response),
            this.#events,
          ),
        )
      ) {
        this.#publish();
      }
      for await (const event of consumeMessageResponse(response, reader)) {
        if (!this.#isActiveTurn(turn)) return;
        turn.receivedFollowUps += turn.receivedFollowUpEvents.get(event) ?? 0;
        turn.receivedFollowUpEvents.delete(event);
      }

      if (!this.#isActiveTurn(turn)) return;

      await followSteeredTurns(turn, reader, () => this.#isActiveTurn(turn));
      if (!this.#isActiveTurn(turn)) return;
      this.#status = this.#error === undefined ? "ready" : "error";
    } catch (error) {
      if (!this.#isActiveTurn(turn)) return;

      if (isAbortError(error)) {
        this.#status = "ready";
        this.#messageSubmissions.fail(toError(error), submissionId);
      } else {
        const reported = this.#error !== undefined;
        this.#error ??= toError(error);
        this.#status = "error";
        this.#messageSubmissions.fail(this.#error, submissionId);
        if (!reported) this.#callbacks.onError?.(this.#error);
      }
    } finally {
      reader?.[Symbol.dispose]();
      this.#finishTurn(turn);
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

    const session = this.#session;
    const turn = createActiveTurn(() => session.cancel());
    this.#activeTurn = turn;
    turn.resolveResponse(undefined);
    this.#error = undefined;
    this.#status = "resuming";
    this.#publish();

    let reader: SessionEventReader | undefined;
    try {
      const stream = this.#ensureStream({
        catchUp: true,
        startIndex:
          this.#events.length === session.state.streamIndex ? session.state.streamIndex : 0,
      });
      reader = stream.subscribe(turn.abortController.signal);
      await stream.caughtUp;
      if (!this.#isActiveTurn(turn)) return;
      reader.discard();
      const tail = this.#events.at(-1);
      if (tail !== undefined) this.#applyTerminalStreamFailure(tail);
      if (
        tail &&
        !this.#error &&
        !isSettledSessionTail(this.#events, this.#conversationClient.conversation)
      ) {
        this.#status = "streaming";
        this.#publish();
        for await (const event of reader) {
          if (!this.#isActiveTurn(turn)) return;
          turn.receivedFollowUps += turn.receivedFollowUpEvents.get(event) ?? 0;
          turn.receivedFollowUpEvents.delete(event);
          if (
            isCurrentTurnBoundaryEvent(event) &&
            !hasPendingAuthorizations(this.#conversationClient.conversation)
          )
            break;
        }
      }
      await followSteeredTurns(turn, reader, () => this.#isActiveTurn(turn));
      if (this.#isActiveTurn(turn)) this.#status = this.#error === undefined ? "ready" : "error";
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
      reader?.[Symbol.dispose]();
      this.#finishTurn(turn);
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
    if (turn === undefined) {
      return this.#status === "streaming" && this.#session !== undefined
        ? this.#session.cancel()
        : Promise.resolve({ status: "no_active_turn" });
    }
    return turn.cancel();
  }

  /** Queues server-side compaction of the current session's context. */
  async compact(): Promise<CompactResult> {
    return (await this.#session?.compact()) ?? { status: "no_active_session" };
  }

  /** Clears the current session's model-message history on the server. */
  async clear(): Promise<ClearResult> {
    return (await this.#session?.clear()) ?? { status: "no_active_session" };
  }

  /**
   * Terminally retires the current server session, then resets local state so
   * the next send starts a fresh session. A failed request leaves both intact.
   */
  async retire(): Promise<ResetResult> {
    const result = (await this.#session?.reset()) ?? { status: "no_active_session" };
    this.reset();
    return result;
  }

  [attachStore](): void {
    this.#attached = true;
    if (this.#followChildStreams && !this.#conversationClient.following) this.#followSubagents();
    if (this.#autoPrewarm && this.#session === undefined) void this.prewarm().catch(() => {});
  }

  [detachStore](): void {
    this.#attached = false;
    this.#conversationClient.stop();
    this.#activeTurn?.abortController.abort();
    this.#resetPrewarm();
    this.#resumePromise = undefined;
  }

  reset(): void {
    this.#conversationClient.stop();
    const turn = this.#activeTurn;
    this.#activeTurn = undefined;
    turn?.resolveResponse(undefined);
    turn?.resolveCompletion();
    turn?.abortController.abort();
    this.#resetPrewarm();
    this.#resumePromise = undefined;
    if (!this.#externalSession) this.#session = undefined;
    this.#events = [];
    this.#conversationClient.reset();
    this.#messageSubmissions.reset();
    if (this.#followChildStreams && this.#attached) this.#followSubagents();
    this.#error = undefined;
    this.#status = "ready";
    this.#callbacks.onSessionChange?.(this.#session?.state);
    this.#publish();
    if (this.#autoPrewarm && this.#attached) void this.prewarm().catch(() => {});
  }

  async #sendFollowUp<TOutput>(
    turn: ActiveTurn,
    input: SendTurnPayload<TOutput>,
    prepareSend?: PrepareSend,
  ): Promise<void> {
    if (input.message === undefined || input.turnPolicy !== "steer") {
      throw new Error(
        'eve session is already processing a turn. Send a message with turnPolicy: "steer" to guide it at the next boundary.',
      );
    }

    const generation = this.#prewarmGeneration;
    const signal = createAbortSignal(input.signal, turn.abortController.signal);
    const preparedInput =
      (await waitWithSignal(Promise.resolve(prepareSend?.(input)), signal)) ?? input;
    if (generation !== this.#prewarmGeneration) return;
    assertExclusiveTurnInput(preparedInput);
    if (preparedInput.message === undefined || preparedInput.turnPolicy !== "steer") {
      throw new Error('An in-flight follow-up requires a message with turnPolicy: "steer".');
    }
    if (!this.#isActiveTurn(turn)) return await this.#submit(preparedInput);

    const submissionId = this.#messageSubmissions.submit(
      preparedInput,
      this.#events.length,
      activeTurnForOptimisticFollowUp(this.#events),
    );
    if (submissionId !== undefined) turn.followUpSubmissionIds.add(submissionId);
    this.#publish();

    let dispatch!: Promise<void>;
    dispatch = (async () => {
      try {
        const signal = createAbortSignal(preparedInput.signal, turn.abortController.signal);
        // The active turn may still be creating the session this follow-up steers.
        await waitWithSignal(turn.response, signal);
        if (!this.#isActiveTurn(turn) || this.#session === undefined) {
          throw new Error("The active eve turn ended before the follow-up could be sent.");
        }
        this.#ensureStream({
          headers: preparedInput.headers,
          streamReconnectPolicy: preparedInput.streamReconnectPolicy,
        });
        const response = (
          await dispatchSessionTurn({
            session: this.#session,
            turn: { ...preparedInput, signal },
          })
        ).response;
        turn.acceptedFollowUps += 1;
        if (
          this.#handleReconciliation(
            this.#messageSubmissions.correlate(
              submissionId,
              getMessageResponseDeliveryId(response),
              this.#events,
            ),
          )
        ) {
          this.#publish();
        }
      } catch (error) {
        if (this.#isActiveTurn(turn)) {
          this.#messageSubmissions.fail(toError(error), submissionId);
          this.#publish();
        }
        throw error;
      } finally {
        turn.followUpDispatches.delete(dispatch);
      }
    })();
    turn.followUpDispatches.add(dispatch);

    await dispatch;
    await turn.completion;
  }

  async #dispatchTurn<TOutput>(input: SendTurnPayload<TOutput>): Promise<{
    readonly response: MessageResponse<TOutput>;
    readonly reader: SessionEventReader;
  }> {
    const streamOptions = {
      headers: input.headers,
      streamReconnectPolicy: input.streamReconnectPolicy,
    };
    if (this.#prewarmPromise !== undefined) {
      // A failed speculative create must not prevent the user's message from being sent.
      await waitWithSignal(
        this.#prewarmPromise.catch((error: unknown) => {
          if (this.#session !== undefined) throw error;
        }),
        input.signal,
      );
      input.signal?.throwIfAborted();
    }
    const session = this.#session;
    let reader: SessionEventReader | undefined;
    try {
      const dispatched = await dispatchSessionTurn({
        client: this.#client,
        session,
        turn: input,
        beforeSend: () => {
          reader = this.#ensureStream(streamOptions).subscribe(input.signal);
        },
      });
      if (dispatched.created) {
        this.#adoptSession(dispatched.session);
        reader = this.#ensureStream(streamOptions).subscribe(input.signal);
      }
      return { response: dispatched.response, reader: reader! };
    } catch (error) {
      reader?.[Symbol.dispose]();
      throw error;
    }
  }

  #ensureStream(
    options: Omit<SessionEventStreamOptions, "onEvent" | "onError"> = {},
  ): SessionEventStream {
    if (this.#session === undefined)
      throw new Error("A session is required before opening its stream.");
    const generation = this.#prewarmGeneration;
    return this.#conversationClient.stream(this.#session, {
      ...options,
      onEvent: (event) => {
        if (generation === this.#prewarmGeneration) this.#acceptServerEvent(event);
      },
      onError: (error) => {
        if (generation !== this.#prewarmGeneration || this.#activeTurn !== undefined) return;
        this.#fail(error);
      },
    });
  }

  #adoptSession(session: ClientSession): void {
    this.#session = session;
    if (this.#followChildStreams && this.#attached) this.#followSubagents();
    this.#callbacks.onSessionChange?.(session.state);
    this.#publish();
  }

  #fail(error: unknown): void {
    this.#error = toError(error);
    this.#status = "error";
    this.#callbacks.onError?.(this.#error);
    this.#publish();
  }

  #followSubagents(): void {
    if (!this.#session) return;
    const session = this.#session;
    this.#conversationClient.follow({ session: () => session }, this.#events);
  }

  #resetPrewarm(): void {
    this.#prewarmGeneration += 1;
    this.#prewarmController?.abort();
    this.#prewarmController = undefined;
    this.#prewarmPromise = undefined;
  }

  #finishTurn(turn: ActiveTurn): void {
    if (!this.#isActiveTurn(turn)) return;
    turn.resolveResponse(undefined);
    this.#activeTurn = undefined;
    try {
      this.#callbacks.onSessionChange?.(this.#session?.state);
      this.#publish();
      this.#callbacks.onFinish?.(this.#snapshot);
    } finally {
      turn.resolveCompletion();
    }
  }

  #isActiveTurn(turn: ActiveTurn): boolean {
    return this.#activeTurn === turn;
  }

  #projectInputResponses(input: SendTurnPayload): void {
    if (!input.inputResponses?.length) return;
    this.#conversationClient.append({
      data: { createdAt: Date.now(), responses: input.inputResponses },
      type: "client.input.responded",
    });
  }

  #acceptServerEvent(event: MessageStreamEvent): boolean {
    const wasStreaming = this.#status === "streaming";
    if (
      !this.#conversationClient.observe(event, {
        onAccepted: () => {
          this.#events = [...this.#events, event];
        },
        project: (accepted) => {
          this.#handleReconciliation(this.#messageSubmissions.apply(accepted));
        },
        notify: false,
      })
    )
      return false;
    this.#callbacks.onEvent?.(event);
    this.#applyTerminalStreamFailure(event);
    const settled = isSettledSessionTail(this.#events, this.#conversationClient.conversation);
    if (this.#status !== "resuming" && this.#error === undefined) {
      if ("data" in event && "turnId" in event.data) this.#status = "streaming";
      if (this.#activeTurn === undefined && settled) this.#status = "ready";
    }
    this.#callbacks.onSessionChange?.(this.#session?.state);
    // Catch-up publishes once when it ends; a notification per replayed event would force one
    // React commit per event within a single task and trip React's nested update limit.
    if (this.#status !== "resuming") this.#publish();
    if (this.#activeTurn === undefined && wasStreaming && settled) {
      this.#callbacks.onFinish?.(this.#snapshot);
    }
    return true;
  }

  #handleReconciliation(
    reconciliation: ReturnType<OptimisticMessageSubmissions["apply"]>,
  ): boolean {
    if (reconciliation === undefined) return false;
    if (this.#activeTurn !== undefined) countFollowUpDeliveries(this.#activeTurn, reconciliation);
    return true;
  }

  #applyTerminalStreamFailure(event: MessageStreamEvent): void {
    const error = toTerminalStreamFailureError(event);
    if (error === undefined) return;
    this.#status = "error";
    this.#messageSubmissions.failAll(error);

    if (this.#error === undefined) {
      this.#error = error;
      this.#callbacks.onError?.(error);
    }
  }

  #createSnapshot(): EveAgentStoreSnapshot<TData> {
    return {
      data: this.#conversationClient.data,
      conversation: this.#conversationClient.conversation,
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

/** @internal Starts mount-scoped session work after the framework commits. */
export function attachEveAgentStore<TData>(store: EveAgentStore<TData>): void {
  store[attachStore]();
}
