import type { SessionStreamEvent } from "#protocol/session-event.js";
import { throwIfAborted } from "#client/abort-signal.js";
import { Client } from "#client/client.js";
import type {
  SessionStoreCallbacks,
  SessionStoreInit,
  SessionStoreSnapshot,
} from "#client/session-store-state.js";
import { StreamDelivery, type Delivery } from "#client/delivery.js";
import { SessionNotActiveError } from "#channel/session-not-active-error.js";
import type {
  SessionEventStream,
  SessionEventStreamOptions,
} from "#client/session-event-stream.js";
import { OptimisticMessageSubmissions } from "#client/optimistic-message-submissions.js";
import { ConversationClient } from "#client/conversation-client.js";
import type { ClientSession } from "#client/session.js";
import {
  assertAnswerable,
  assertExclusiveTurnInput,
  isAbortError,
} from "#client/session-store-helpers.js";
import { activeTurn, failure, idle } from "#protocol/session-projection/selectors.js";
import type { DeliveryReceipt } from "#protocol/delivery.js";
import { toError } from "#shared/errors.js";
import { waitWithSignal } from "#shared/wait-with-signal.js";
import type { ClientSessionState, SendTurnPayload } from "#client/types.js";

export type {
  SessionStoreCallbacks,
  SessionStoreInit,
  SessionStoreSnapshot,
  SessionStoreStatus,
  PrepareSend,
} from "#client/session-store-state.js";

const detachStore = Symbol("detachSessionStore");
const attachStore = Symbol("attachSessionStore");

/** An observable durable session. Commands resolve on acceptance; only its stream changes its lifecycle. */
export class SessionStore {
  readonly #client: Client | undefined;
  readonly #autoPrewarm: boolean;
  readonly #followChildStreams: NonNullable<SessionStoreInit["followAgents"]>;
  readonly #followWhile: NonNullable<SessionStoreInit["followWhile"]>;
  readonly #externalSession: boolean;
  readonly #subscribers = new Set<() => void>();
  readonly #turnWaiters = new Set<() => void>();
  readonly #conversationClient: ConversationClient;
  readonly #messageSubmissions: OptimisticMessageSubmissions;
  readonly #pending = new Set<Promise<string | undefined>>();
  readonly #accepted = new Set<string>();
  #attached = false;
  #mounted = false;
  #observers = 0;
  #streamingWhenDetached = false;
  #callbacks: SessionStoreCallbacks = {};
  #controller = new AbortController();
  #creation: Promise<Delivery | undefined> | undefined;
  #preparation: { lifetime: AbortController; promise: Promise<void> } | undefined;
  #resumePromise: Promise<void> | undefined;
  #session: ClientSession | undefined;
  #error: Error | undefined;
  #events: readonly SessionStreamEvent[];
  #snapshot: SessionStoreSnapshot;
  #observedSession: ClientSessionState | undefined;
  #inLine = false;
  #posting = 0;
  #finishes = 0;
  readonly #finishedTurns = new Set<string>();
  #endings: {
    event: Extract<SessionStreamEvent, { type: "turn.settled" | "session.ended" }>;
    historical: boolean;
  }[] = [];

  constructor(init: SessionStoreInit) {
    this.#autoPrewarm = init.prewarm ?? false;
    this.#followChildStreams = init.followAgents ?? false;
    this.#followWhile = init.followWhile ?? (() => true);
    this.#externalSession = init.session !== undefined;
    this.#client = this.#externalSession
      ? undefined
      : (init.client ??
        new Client({
          auth: init.auth,
          headers: init.headers,
          baseUrl: init.baseUrl ?? "",
        }));
    this.#conversationClient = new ConversationClient(() => this.#publish());
    this.#events = (init.initialEvents ?? []).filter((event) =>
      this.#conversationClient.hydrate(event),
    );
    this.#messageSubmissions = new OptimisticMessageSubmissions(
      (submissions) => this.#conversationClient.showSubmissions(submissions),
      init.optimistic ?? true,
    );
    this.#session =
      init.session ??
      (init.initialSession === undefined
        ? undefined
        : this.#client?.sessions.attach(init.initialSession.sessionId, {
            streamIndex: init.initialSession.streamIndex,
            inbox: init.initialSession.inbox,
          }));
    this.#error = this.#recordedFailure();
    this.#snapshot = this.#createSnapshot();
  }

  get snapshot(): SessionStoreSnapshot {
    return this.#snapshot;
  }

  /** Activates observation outside a framework. Release the scope to stop reads, not execution. */
  observe(): () => void {
    this.#observers += 1;
    this.#activateObservation();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#observers -= 1;
      if (!this.#mounted && this.#observers === 0) this.#deactivateObservation();
    };
  }

  setCallbacks(callbacks: SessionStoreCallbacks): void {
    this.#callbacks = callbacks;
  }

  subscribe(callback: () => void): () => void {
    this.#subscribers.add(callback);
    return () => void this.#subscribers.delete(callback);
  }

  /**
   * Creates an idle session, sharing creation with sends already in flight, or
   * prepares an existing session's idle owner without a model turn.
   */
  async prewarm(): Promise<void> {
    if (this.#session !== undefined) return await this.#prepare(this.#session);
    const lifetime = this.#controller;
    try {
      await this.#create();
    } catch (error) {
      if (lifetime === this.#controller && !isAbortError(error) && this.#pending.size === 0)
        this.#fail(error);
      throw error;
    }
    if (
      lifetime === this.#controller &&
      this.#followWhile(this.#conversationClient.conversation.view)
    )
      this.#ensureStream();
  }

  /** Accepts a message or answers. Observe the stream for its durable result. */
  async send<TOutput = unknown>(input: SendTurnPayload<TOutput>): Promise<Delivery<TOutput>> {
    if (this.#resumePromise !== undefined) throw new Error("eve session is resuming.");
    assertExclusiveTurnInput(input);
    assertAnswerable(input, this.#conversationClient.conversation);
    const lifetime = this.#controller;
    const signal = input.signal
      ? AbortSignal.any([lifetime.signal, input.signal])
      : lifetime.signal;
    const accepted = Promise.withResolvers<string | undefined>();
    this.#pending.add(accepted.promise);
    this.#error = undefined;
    let submissionId = this.#messageSubmissions.submit(
      input,
      input.turnPolicy === "steer" ? activeTurn(this.#conversationClient.view)?.turnId : undefined,
    );
    let retract = this.#conversationClient.projectAnswers(input.answers);
    this.#publish();
    let posting = false;
    try {
      const prepared =
        this.#callbacks.prepareSend === undefined
          ? input
          : await waitWithSignal(Promise.resolve(this.#callbacks.prepareSend(input)), signal);
      throwIfAborted(signal);
      assertExclusiveTurnInput(prepared);
      if (prepared !== input) {
        submissionId = this.#messageSubmissions.resubmit(submissionId, prepared);
        retract = this.#conversationClient.replaceAnswers(retract, prepared);
        this.#publish();
      }
      // Keep the optimistic row stable until its accepted delivery identity is known, even if
      // the stream beats the POST response. No renderer has to match messages by text.
      posting = true;
      this.#posting += 1;
      const delivery = await this.#dispatch({ ...prepared, signal });
      throwIfAborted(signal);
      const deliveryId = delivery.deliveryId;
      if (deliveryId === undefined)
        throw new Error("The server did not identify the accepted delivery.");
      retract?.accept(deliveryId);
      retract = undefined;
      if (lifetime === this.#controller) {
        if (submissionId !== undefined) {
          this.#conversationClient.confirmSubmission(submissionId, deliveryId);
          this.#messageSubmissions.correlate(submissionId, deliveryId);
        }
        this.#acceptReceipt(deliveryId);
        this.#callbacks.onSessionChange?.(this.#sessionState);
      }
      accepted.resolve(deliveryId);
      return new StreamDelivery<TOutput>({
        sessionId: delivery.sessionId,
        deliveryId,
        createStream: (read) => delivery.stream(read),
      });
    } catch (error) {
      if (lifetime === this.#controller) {
        retract?.();
        this.#messageSubmissions.fail(toError(error), submissionId);
        if (!isAbortError(error)) this.#fail(error);
      }
      throw error;
    } finally {
      accepted.resolve(undefined);
      if (lifetime === this.#controller) {
        this.#pending.delete(accepted.promise);
        if (posting) this.#posting -= 1;
        this.#publish();
        this.#closeStreamWhenIdle();
      }
    }
  }

  /**
   * Follow an accepted delivery in this session until it settles or the session ends.
   * The receipt may come from another store. Repeating it is safe and retries a closed stream.
   * Pass only a receipt returned by `send`, `respond`, `clear`, `compact`, or `reset`: a receipt
   * may arrive before its delivery is admitted, so an id the stream never admits keeps the store
   * busy and its stream open until the session ends or `newSession()`.
   * Catch-up updates recorded failures without replaying live completion callbacks.
   * Normal session stream authorization still applies.
   */
  follow(receipt: DeliveryReceipt): void {
    if (this.#session === undefined)
      throw new Error("An eve session is required before following.");
    if (receipt.sessionId !== this.#session.id)
      throw new Error("The delivery belongs to a different eve session.");
    const view = this.#conversationClient.view;
    const delivery = view.deliveries[receipt.deliveryId];
    if (view.session.status === "ended" || delivery?.status === "settled") return;
    this.#error = undefined;
    this.#acceptReceipt(receipt.deliveryId);
    if (this.#accepted.has(receipt.deliveryId)) this.#ensureStream();
    this.#publish();
  }

  /** Replays through the durable tail; subsequent following obeys `followWhile`. */
  resume(): Promise<void> {
    if (this.#resumePromise !== undefined) return this.#resumePromise;
    if (this.#session === undefined)
      return Promise.reject(new Error("An eve session is required before resuming."));
    if (this.#pending.size > 0)
      return Promise.reject(new Error("eve session has pending submissions."));
    const lifetime = this.#controller;
    this.#error = undefined;
    const stream = this.#ensureStream({ startIndex: this.#conversationClient.view.position });
    const promise = stream.caughtUp
      .then(() => {
        if (lifetime === this.#controller) this.#error ??= this.#recordedFailure();
      })
      .finally(() => {
        if (lifetime !== this.#controller) return;
        this.#resumePromise = undefined;
        this.#publish();
        this.#closeStreamWhenIdle();
      });
    this.#resumePromise = promise;
    this.#publish(true);
    return promise;
  }

  /** Cancels the current turn, waiting for a pending submission's turn when necessary. */
  async cancel(): Promise<Delivery> {
    const lifetime = this.#controller;
    const turnId =
      activeTurn(this.#conversationClient.view)?.turnId ??
      (await this.#submittedTurn(lifetime.signal));
    throwIfAborted(lifetime.signal);
    return this.#control((session) => session.cancel({ turnId: turnId ?? null }));
  }

  async #submittedTurn(signal: AbortSignal): Promise<string | undefined> {
    const deliveries = new Set(this.#accepted.keys());
    const pending = [...this.#pending];
    let remaining = pending.length;
    const result = Promise.withResolvers<string | undefined>();
    const check = () => {
      const view = this.#conversationClient.view;
      if (view.session.status === "ended") return result.resolve(undefined);
      for (const id of deliveries) {
        const delivery = view.deliveries[id];
        const turn = delivery?.turnId === undefined ? undefined : view.turns[delivery.turnId];
        if (turn?.status === "running") return result.resolve(turn.turnId);
        if (delivery?.status === "settled" || turn?.status === "settled") deliveries.delete(id);
      }
      if (remaining === 0 && deliveries.size === 0) result.resolve(undefined);
      else if (this.#error !== undefined) result.reject(this.#error);
    };
    this.#turnWaiters.add(check);
    for (const receipt of pending) {
      void receipt.then((id) => {
        remaining -= 1;
        if (id !== undefined) deliveries.add(id);
        check();
      });
    }
    try {
      check();
      return await waitWithSignal(result.promise, signal);
    } finally {
      this.#turnWaiters.delete(check);
    }
  }

  compact(): Promise<Delivery> {
    return this.#control((session) => session.compact());
  }
  clear(): Promise<Delivery> {
    return this.#control((session) => session.clear());
  }
  reset(): Promise<Delivery> {
    return this.#control((session) => session.reset());
  }

  async #control(dispatch: (session: ClientSession) => Promise<Delivery>): Promise<Delivery> {
    const session = this.#session;
    if (session === undefined) throw new SessionNotActiveError();
    const lifetime = this.#controller;
    this.#posting += 1;
    this.#ensureStream();
    this.#publish();
    try {
      const receipt = await dispatch(session);
      throwIfAborted(lifetime.signal);
      this.#acceptReceipt(receipt.deliveryId);
      return receipt;
    } finally {
      if (lifetime === this.#controller) {
        this.#posting -= 1;
        this.#publish();
        this.#closeStreamWhenIdle();
      }
    }
  }

  [attachStore](): void {
    this.#mounted = true;
    this.#activateObservation();
  }

  #activateObservation(): void {
    if (this.#attached) return;
    this.#attached = true;
    this.#followAgents();
    const resumeFollowing =
      this.#streamingWhenDetached && this.#followWhile(this.#conversationClient.conversation.view);
    this.#streamingWhenDetached = false;
    if (this.#session !== undefined && (this.#hasLocalObligation || resumeFollowing))
      this.#ensureStream();
    if (this.#autoPrewarm && this.#session === undefined) void this.prewarm().catch(() => {});
  }

  [detachStore](): void {
    this.#mounted = false;
    if (this.#observers === 0) this.#deactivateObservation();
  }

  #deactivateObservation(): void {
    this.#attached = false;
    this.#streamingWhenDetached = this.#conversationClient.streaming;
    this.#stop();
  }

  newSession(): void {
    this.#stop();
    if (!this.#externalSession) this.#session = undefined;
    this.#accepted.clear();
    this.#finishedTurns.clear();
    this.#events = [];
    this.#conversationClient.reset();
    this.#messageSubmissions.reset();
    this.#error = undefined;
    if (this.#attached) this.#followAgents();
    this.#callbacks.onSessionChange?.(this.#sessionState);
    this.#publish();
    if (this.#autoPrewarm && this.#attached) void this.prewarm().catch(() => {});
  }

  #stop(): void {
    this.#conversationClient.stop();
    this.#controller.abort();
    this.#controller = new AbortController();
    this.#creation = undefined;
    this.#resumePromise = undefined;
    this.#pending.clear();
    this.#posting = 0;
    this.#finishes = 0;
    this.#abandonLine();
  }

  /** Rolls back to the committed line; replaying from the folded cursor delivers it again. */
  #abandonLine(): void {
    this.#conversationClient.closeStream();
    let end = this.#events.length;
    while (end > 0 && this.#events[end - 1]!.meta.endOfLine === false) end -= 1;
    if (end < this.#events.length) this.#events = this.#events.slice(0, end);
    this.#endings = [];
    this.#inLine = false;
  }

  #create(input?: SendTurnPayload): Promise<Delivery | undefined> {
    if (this.#creation !== undefined) return this.#creation;
    const client = this.#client;
    if (client === undefined)
      return Promise.reject(new Error("This store cannot create a session."));
    const lifetime = this.#controller;
    const signal = input?.signal ?? lifetime.signal;
    const promise = (async () => {
      let session: ClientSession;
      let delivery: Delivery | undefined;
      if (input?.message === undefined) ({ session } = await client.sessions.create({ signal }));
      else
        ({ session, delivery } = await client.sessions.create({
          ...input,
          message: input.message,
          signal,
        }));
      throwIfAborted(lifetime.signal);
      this.#session = session;
      this.#error = undefined;
      this.#callbacks.onSessionChange?.(this.#sessionState);
      this.#followAgents();
      this.#publish();
      return delivery;
    })();
    this.#creation = promise;
    const clear = () => {
      if (this.#creation === promise) this.#creation = undefined;
    };
    void promise.then(clear, clear);
    return promise;
  }

  // Preparation is advisory: its failure is the caller's, and sends never wait for it.
  #prepare(session: ClientSession): Promise<void> {
    const lifetime = this.#controller;
    if (this.#preparation?.lifetime === lifetime) return this.#preparation.promise;
    const promise = session.prewarm({ signal: lifetime.signal }).then(() => undefined);
    const preparation = { lifetime, promise };
    this.#preparation = preparation;
    const clear = () => {
      if (this.#preparation === preparation) this.#preparation = undefined;
    };
    void promise.then(clear, clear);
    return promise;
  }

  async #dispatch(input: SendTurnPayload): Promise<Delivery> {
    if (this.#creation !== undefined) {
      // Speculative prewarm failure must not prevent a message creating its session.
      await waitWithSignal(
        this.#creation.catch(() => undefined),
        input.signal,
      );
    }
    throwIfAborted(input.signal);
    if (this.#session === undefined) {
      if (input.message === undefined) throw new Error("Cannot answer before the session starts.");
      const delivery = await this.#create(input);
      this.#ensureStream(input);
      if (delivery === undefined)
        throw new Error("The session was created without accepting a message.");
      return delivery;
    }
    this.#ensureStream(input);
    return input.answers === undefined
      ? await this.#session.send(input.message, input)
      : await this.#session.respond(input.answers, input);
  }

  #ensureStream(
    options: Omit<SessionEventStreamOptions, "onEvent" | "onError"> = {},
  ): SessionEventStream {
    if (this.#session === undefined)
      throw new Error("A session is required before opening its stream.");
    this.#followAgents();
    const lifetime = this.#controller;
    return this.#conversationClient.stream(this.#session, {
      startIndex: this.#conversationClient.view.position,
      ...options,
      onEvent: (event, historical) => {
        if (lifetime === this.#controller) this.#acceptServerEvent(event, historical);
      },
      onError: (error) => {
        if (lifetime !== this.#controller) return;
        this.#abandonLine();
        this.#fail(error);
      },
    });
  }

  #followAgents(): void {
    if (this.#followChildStreams && this.#session)
      this.#conversationClient.follow(this.#session, this.#followChildStreams);
  }

  #acceptServerEvent(event: SessionStreamEvent, historical: boolean): void {
    const lifetime = this.#controller;
    this.#inLine = event.meta.endOfLine === false;
    if (!this.#conversationClient.observe(event, { notify: false })) return;
    this.#events = [...this.#events, event];
    this.#callbacks.onEvent?.(event);
    if (lifetime !== this.#controller) return;
    if (event.type === "turn.started" && !historical) this.#error = undefined;
    if (event.type === "turn.settled" || event.type === "session.ended")
      this.#endings.push({ event, historical });
    if (this.#inLine) return;
    const view = this.#conversationClient.view;
    const relevantTurns = new Set(
      [...this.#accepted].map((id) => view.deliveries[id]?.turnId).filter((id) => id !== undefined),
    );
    this.#reconcile();
    for (const ending of this.#endings.splice(0)) {
      if (ending.event.type === "turn.settled") {
        if (!ending.historical) this.#finishTurn(ending.event.data.turnId);
        else if (relevantTurns.has(ending.event.data.turnId) && this.#pending.size === 0)
          this.#error ??= this.#recordedFailure(ending.event.data.turnId);
      } else if (ending.event.data.outcome === "failed") {
        const error = Object.assign(
          new Error(ending.event.data.error?.message ?? "The session failed."),
          {
            name: ending.event.data.error?.code ?? "SESSION_FAILED",
          },
        );
        if (!ending.historical) this.#fail(error);
        else if (this.#pending.size === 0) this.#error ??= error;
      }
      if (lifetime !== this.#controller) return;
    }
    for (const check of this.#turnWaiters) check();
    this.#callbacks.onSessionChange?.(this.#sessionState);
    if (lifetime !== this.#controller) return;
    this.#publish();
    if (lifetime !== this.#controller) return;
    this.#conversationClient.reconcileFollowing();
    if (lifetime !== this.#controller) return;
    this.#closeStreamWhenIdle();
  }

  #acceptReceipt(deliveryId: string): void {
    this.#accepted.add(deliveryId);
    this.#reconcile();
    const view = this.#conversationClient.view;
    const turnId = view.deliveries[deliveryId]?.turnId;
    if (turnId !== undefined && view.turns[turnId]?.status === "settled")
      this.#error ??= this.#recordedFailure(turnId);
    if (view.session.status === "ended") this.#error ??= this.#recordedFailure();
  }

  #reconcile(): void {
    const view = this.#conversationClient.view;
    if (view.session.status === "ended") this.#accepted.clear();
    this.#messageSubmissions.reconcile(view);
    for (const id of this.#accepted) {
      const delivery = view.deliveries[id];
      if (delivery?.status === "settled") this.#accepted.delete(id);
    }
  }

  get #hasLocalObligation(): boolean {
    return (
      this.#resumePromise !== undefined ||
      this.#posting > 0 ||
      this.#pending.size > 0 ||
      this.#accepted.size > 0
    );
  }

  #closeStreamWhenIdle(): void {
    if (
      this.#inLine ||
      this.#hasLocalObligation ||
      this.#followWhile(this.#conversationClient.conversation.view)
    )
      return;
    this.#conversationClient.closeStream();
  }

  #finishTurn(turnId: string): void {
    if (this.#finishedTurns.has(turnId)) return;
    const row = this.#conversationClient.view.turns[turnId];
    if (row?.status !== "settled") return;
    this.#finishedTurns.add(turnId);
    this.#finishes += 1;
    const error = failure(this.#conversationClient.view, turnId);
    if (error !== undefined)
      this.#fail(Object.assign(new Error(error.message), { name: error.code }));
  }

  #recordedFailure(turnId = this.#conversationClient.view.session.latestTurnId): Error | undefined {
    const view = this.#conversationClient.view;
    const error = failure(view, turnId);
    return error === undefined
      ? undefined
      : Object.assign(new Error(error.message), { name: error.code });
  }

  #fail(error: unknown): void {
    const reported = this.#error !== undefined;
    this.#error = toError(error);
    for (const check of this.#turnWaiters) check();
    if (!reported) this.#callbacks.onError?.(this.#error);
    this.#publish();
  }

  /** Other Delivery/session readers may have read further than this store's committed prefix. */
  get #sessionState(): ClientSessionState | undefined {
    if (this.#session === undefined) return (this.#observedSession = undefined);
    const sessionId = this.#session.id;
    const streamIndex = this.#conversationClient.view.position;
    const { inbox } = this.#session.state;
    if (
      this.#observedSession?.sessionId !== sessionId ||
      this.#observedSession.streamIndex !== streamIndex ||
      this.#observedSession.inbox !== inbox
    ) {
      this.#observedSession = { sessionId, streamIndex, inbox };
    }
    return this.#observedSession;
  }

  #createSnapshot(): SessionStoreSnapshot {
    this.#conversationClient.holdUnconfirmedMessages(
      this.#posting > 0 && this.#messageSubmissions.awaitingReceipt,
    );
    const data = this.#conversationClient.conversation;
    const { view } = data;
    return {
      ...data,
      view,
      error: this.#error,
      events: this.#events,
      session: this.#sessionState,
      status:
        this.#resumePromise !== undefined
          ? "resuming"
          : this.#hasLocalObligation || !idle(this.#conversationClient.view)
            ? "busy"
            : "idle",
    };
  }

  #publish(force = false): void {
    if (this.#resumePromise !== undefined && !force) return;
    if (this.#inLine) {
      if (this.#error === undefined && !this.#hasLocalObligation) return;
      // Keep the committed projection intact even when an obligation or failure arrives mid-line.
      this.#snapshot = {
        ...this.#snapshot,
        error: this.#error,
        status:
          this.#resumePromise !== undefined
            ? "resuming"
            : this.#hasLocalObligation
              ? "busy"
              : this.#snapshot.status,
      };
      for (const subscriber of this.#subscribers) subscriber();
      return;
    }
    this.#snapshot = this.#createSnapshot();
    const finishes = this.#finishes;
    const lifetime = this.#controller;
    this.#finishes = 0;
    for (const subscriber of this.#subscribers) subscriber();
    for (let index = 0; index < finishes && lifetime === this.#controller; index += 1)
      this.#callbacks.onFinish?.(this.#snapshot);
  }
}

/** @internal Detaches local transport without cancelling durable server work. */
export function detachSessionStore(store: SessionStore): void {
  store[detachStore]();
}

/** @internal Starts mount-scoped session work after the framework commits. */
export function attachSessionStore(store: SessionStore): void {
  store[attachStore]();
}
