import type { SessionStreamEvent } from "#protocol/session-event.js";
import { throwIfAborted } from "#client/abort-signal.js";
import { Client } from "#client/client.js";
import type {
  AcceptedDelivery,
  EveAgentStoreCallbacks,
  EveAgentStoreInit,
  EveAgentStoreSnapshot,
} from "#client/eve-agent-store-state.js";
import type { MessageResponse } from "#client/message-response.js";
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
  waitWithSignal,
} from "#client/eve-agent-store-helpers.js";
import { activeTurn, failure, idle } from "#protocol/session-projection/selectors.js";
import { openSignIns } from "#protocol/session-reader.js";
import { toError } from "#shared/errors.js";
import type {
  CancelSessionResult,
  ClearResult,
  CompactResult,
  ResetResult,
  SendTurnPayload,
} from "#client/types.js";

export type {
  AcceptedDelivery,
  EveAgentStoreCallbacks,
  EveAgentStoreInit,
  EveAgentStoreSnapshot,
  EveAgentStoreStatus,
  PrepareSend,
} from "#client/eve-agent-store-state.js";

const detachStore = Symbol("detachEveAgentStore");
const attachStore = Symbol("attachEveAgentStore");

/** An observable durable session. Commands resolve on acceptance; only its stream changes its lifecycle. */
export class EveAgentStore {
  readonly #client: Client | undefined;
  readonly #autoPrewarm: boolean;
  readonly #followChildStreams: boolean;
  readonly #followIdle: boolean;
  readonly #externalSession: boolean;
  readonly #subscribers = new Set<() => void>();
  readonly #turnWaiters = new Set<() => void>();
  readonly #conversationClient: ConversationClient;
  readonly #messageSubmissions: OptimisticMessageSubmissions;
  readonly #pending = new Set<Promise<string | undefined>>();
  readonly #accepted = new Set<string>();
  #attached = false;
  #callbacks: EveAgentStoreCallbacks = {};
  #controller = new AbortController();
  #creation: Promise<MessageResponse | undefined> | undefined;
  #resumePromise: Promise<void> | undefined;
  #session: ClientSession | undefined;
  #error: Error | undefined;
  #events: readonly SessionStreamEvent[];
  #snapshot: EveAgentStoreSnapshot;
  #inLine = false;
  #posting = 0;
  #finishes = 0;

  constructor(init: EveAgentStoreInit) {
    this.#autoPrewarm = init.prewarm ?? false;
    this.#followChildStreams = init.followSubagents ?? false;
    this.#followIdle = init.followIdle ?? true;
    this.#externalSession = init.session !== undefined;
    this.#client = this.#externalSession
      ? undefined
      : (init.client ??
        new Client({
          auth: init.auth,
          headers: init.headers,
          host: init.host ?? "",
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
          }));
    this.#error = this.#recordedFailure();
    this.#snapshot = this.#createSnapshot();
  }

  get snapshot(): EveAgentStoreSnapshot {
    return this.#snapshot;
  }

  setCallbacks(callbacks: EveAgentStoreCallbacks): void {
    this.#callbacks = callbacks;
  }

  subscribe(callback: () => void): () => void {
    this.#subscribers.add(callback);
    return () => void this.#subscribers.delete(callback);
  }

  /** Creates an idle session, sharing creation with sends already in flight. */
  async prewarm(): Promise<void> {
    if (this.#session !== undefined) return;
    const lifetime = this.#controller;
    try {
      await this.#create();
    } catch (error) {
      if (lifetime === this.#controller && !isAbortError(error) && this.#pending.size === 0)
        this.#fail(error);
      throw error;
    }
    if (lifetime === this.#controller && this.#followIdle) this.#ensureStream();
  }

  /** Accepts a message or answers. Observe the stream for its durable result. */
  async send<TOutput = unknown>(input: SendTurnPayload<TOutput>): Promise<AcceptedDelivery> {
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
      const response = await this.#dispatch({ ...prepared, signal });
      throwIfAborted(signal);
      const deliveryId = response.deliveryId;
      if (deliveryId === undefined)
        throw new Error("The server did not identify the accepted delivery.");
      retract?.accept(deliveryId);
      retract = undefined;
      this.#accepted.add(deliveryId);
      if (submissionId !== undefined) {
        this.#conversationClient.confirmSubmission(submissionId, deliveryId);
        this.#messageSubmissions.correlate(submissionId, deliveryId);
      }
      this.#reconcile();
      accepted.resolve(deliveryId);
      return { deliveryId, sessionId: response.sessionId };
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

  /** Replays through the current durable tail, then follows independently of this promise. */
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
      .catch((error: unknown) => {
        if (lifetime === this.#controller && !isAbortError(error)) this.#fail(error);
        throw error;
      })
      .finally(() => {
        if (lifetime !== this.#controller) return;
        this.#resumePromise = undefined;
        this.#finishes = 0;
        this.#publish();
        this.#closeStreamWhenIdle();
      });
    this.#resumePromise = promise;
    this.#publish(true);
    return promise;
  }

  /** Cancels the current turn, waiting for a pending submission's turn when necessary. */
  async cancel(): Promise<CancelSessionResult> {
    const lifetime = this.#controller;
    const turnId =
      activeTurn(this.#conversationClient.view)?.turnId ??
      (await this.#submittedTurn(lifetime.signal));
    throwIfAborted(lifetime.signal);
    return turnId === undefined || this.#session === undefined
      ? { status: "no_active_turn" }
      : await this.#session.cancel({ turnId });
  }

  async #submittedTurn(signal: AbortSignal): Promise<string | undefined> {
    const deliveries = new Set(this.#accepted);
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

  async compact(): Promise<CompactResult> {
    return (await this.#session?.compact()) ?? { status: "no_active_session" };
  }

  async clear(): Promise<ClearResult> {
    return (await this.#session?.clear()) ?? { status: "no_active_session" };
  }

  async retire(): Promise<ResetResult> {
    if (this.#externalSession)
      throw new Error(
        "retire() needs a store-owned session. Reset the supplied session explicitly.",
      );
    const result = (await this.#session?.reset()) ?? { status: "no_active_session" };
    this.reset();
    return result;
  }

  [attachStore](): void {
    this.#attached = true;
    this.#followSubagents();
    if (this.#autoPrewarm && this.#session === undefined) void this.prewarm().catch(() => {});
  }

  [detachStore](): void {
    this.#attached = false;
    this.#stop();
  }

  reset(): void {
    this.#stop();
    if (!this.#externalSession) this.#session = undefined;
    this.#accepted.clear();
    this.#events = [];
    this.#conversationClient.reset();
    this.#messageSubmissions.reset();
    this.#error = undefined;
    if (this.#attached) this.#followSubagents();
    this.#callbacks.onSessionChange?.(this.#session?.state);
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
    this.#inLine = false;
  }

  #create(input?: SendTurnPayload): Promise<MessageResponse | undefined> {
    if (this.#creation !== undefined) return this.#creation;
    const client = this.#client;
    if (client === undefined)
      return Promise.reject(new Error("This store cannot create a session."));
    const lifetime = this.#controller;
    const signal = input?.signal ?? lifetime.signal;
    const promise = (async () => {
      let session: ClientSession;
      let response: MessageResponse | undefined;
      if (input?.message === undefined) ({ session } = await client.sessions.create({ signal }));
      else
        ({ session, response } = await client.sessions.create({
          ...input,
          message: input.message,
          signal,
        }));
      throwIfAborted(lifetime.signal);
      this.#session = session;
      this.#error = undefined;
      this.#callbacks.onSessionChange?.(session.state);
      this.#followSubagents();
      this.#publish();
      return response;
    })();
    this.#creation = promise;
    const clear = () => {
      if (this.#creation === promise) this.#creation = undefined;
    };
    void promise.then(clear, clear);
    return promise;
  }

  async #dispatch(input: SendTurnPayload): Promise<MessageResponse> {
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
      const response = await this.#create(input);
      this.#ensureStream(input);
      if (response === undefined)
        throw new Error("The session was created without accepting a message.");
      return response;
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
    this.#followSubagents();
    const lifetime = this.#controller;
    return this.#conversationClient.stream(this.#session, {
      ...options,
      onEvent: (event) => {
        if (lifetime === this.#controller) this.#acceptServerEvent(event);
      },
      onError: (error) => {
        if (lifetime === this.#controller) this.#fail(error);
      },
    });
  }

  #followSubagents(): void {
    if (this.#followChildStreams && this.#session && !this.#conversationClient.following)
      this.#conversationClient.follow(this.#session, this.#events);
  }

  #acceptServerEvent(event: SessionStreamEvent): void {
    this.#inLine = event.meta.endOfLine === false;
    if (!this.#conversationClient.observe(event, { notify: false })) return;
    this.#events = [...this.#events, event];
    this.#callbacks.onEvent?.(event);
    if (event.type === "turn.started") this.#error = undefined;
    if (event.type === "turn.settled") this.#finishes += 1;
    if (
      (event.type === "session.ended" && event.data.outcome === "failed") ||
      (event.type === "turn.settled" && event.data.outcome === "failed")
    ) {
      const error = new Error(event.data.error?.message ?? "The session failed.");
      error.name = event.data.error?.code ?? "SESSION_FAILED";
      this.#messageSubmissions.failAll(error);
      this.#fail(error);
    }
    if (this.#inLine) return;
    this.#reconcile();
    // Stop observes committed facts even while POST receipts gate public snapshots.
    for (const check of this.#turnWaiters) check();
    this.#callbacks.onSessionChange?.(this.#session?.state);
    this.#publish();
    this.#closeStreamWhenIdle();
  }

  #reconcile(): void {
    const view = this.#conversationClient.view;
    this.#messageSubmissions.reconcile(view);
    for (const id of this.#accepted) {
      const delivery = view.deliveries[id];
      if (delivery !== undefined && delivery.status !== "admitted") this.#accepted.delete(id);
    }
  }

  #closeStreamWhenIdle(): void {
    const view = this.#conversationClient.view;
    if (
      this.#followIdle ||
      this.#resumePromise !== undefined ||
      this.#pending.size > 0 ||
      this.#accepted.size > 0 ||
      activeTurn(view) !== undefined ||
      !idle(view) ||
      openSignIns(view).length > 0
    )
      return;
    this.#conversationClient.closeStream();
  }

  #recordedFailure(): Error | undefined {
    const view = this.#conversationClient.view;
    const error = failure(view, view.session.latestTurnId);
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

  #createSnapshot(): EveAgentStoreSnapshot {
    const data = this.#conversationClient.conversation;
    const { view } = data;
    return {
      ...data,
      view,
      error: this.#error,
      events: this.#events,
      session: this.#session?.state,
      status:
        this.#resumePromise !== undefined
          ? "resuming"
          : activeTurn(view) !== undefined ||
              !idle(view) ||
              this.#pending.size > 0 ||
              this.#accepted.size > 0
            ? "busy"
            : "idle",
    };
  }

  #publish(force = false): void {
    if (this.#posting > 0 || (this.#resumePromise !== undefined && !force)) return;
    if (this.#inLine) {
      if (this.#error === undefined) return;
      // Transport or observer failure must be visible without publishing an unfinished line.
      this.#snapshot = { ...this.#snapshot, error: this.#error };
      for (const subscriber of this.#subscribers) subscriber();
      return;
    }
    this.#snapshot = this.#createSnapshot();
    const finishes = this.#finishes;
    this.#finishes = 0;
    for (const subscriber of this.#subscribers) subscriber();
    for (let index = 0; index < finishes; index += 1) this.#callbacks.onFinish?.(this.#snapshot);
  }
}

/** @internal Detaches local transport without cancelling durable server work. */
export function detachEveAgentStore(store: EveAgentStore): void {
  store[detachStore]();
}

/** @internal Starts mount-scoped session work after the framework commits. */
export function attachEveAgentStore(store: EveAgentStore): void {
  store[attachStore]();
}
