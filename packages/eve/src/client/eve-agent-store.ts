import { Client } from "#client/client.js";
import type { EveAgentReducer, EveAgentReducerEvent } from "#client/reducer.js";
import type { ClientSession } from "#client/session.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { toError } from "#shared/errors.js";
import type { ClientAuth, HeadersValue, SendTurnPayload, SessionState } from "#client/types.js";
import type { UserContent } from "ai";

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
 * this session, `session` is the current serializable cursor, `status` is the
 * turn lifecycle state, and `error` is the last failure (or `undefined`).
 */
export interface EveAgentStoreSnapshot<TData> {
  readonly data: TData;
  readonly error: Error | undefined;
  readonly events: readonly HandleMessageStreamEvent[];
  readonly session: SessionState;
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
  readonly onEvent?: (event: HandleMessageStreamEvent) => void;
  readonly onFinish?: (snapshot: EveAgentStoreSnapshot<TData>) => void;
  readonly onSessionChange?: (session: SessionState) => void;
  readonly prepareSend?: PrepareSend;
}

/**
 * Configuration for constructing an {@link EveAgentStore}.
 *
 * Requires a {@link EveAgentReducer | reducer}, plus either connection options
 * (`host`, `auth`, `headers`, `maxReconnectAttempts`, `initialSession`) for a
 * store-owned session or an existing {@link ClientSession} via `session`.
 *
 * `optimistic` (default `true`) projects submitted user messages before the
 * server confirms them. `host` defaults to `""`. `initialEvents` and
 * `initialSession` seed prior state on construction. Passing `session` makes
 * `reset()` reuse that external session rather than create a new one.
 */
export interface EveAgentStoreInit<TData> {
  readonly auth?: ClientAuth;
  readonly headers?: HeadersValue;
  readonly host?: string;
  readonly initialEvents?: readonly HandleMessageStreamEvent[];
  readonly initialSession?: SessionState;
  readonly maxReconnectAttempts?: number;
  readonly optimistic?: boolean;
  readonly reducer: EveAgentReducer<TData>;
  readonly session?: ClientSession;
}

interface PendingMessageSubmission {
  readonly createdAt: number;
  readonly id: string;
  readonly message: string;
}

/**
 * Framework-agnostic state machine for an eve agent session.
 *
 * Manages the send/stream lifecycle, optimistic projection, and subscriber
 * notification; framework integrations (React, Vue) wrap it with their own
 * reactivity primitives.
 *
 * Drives one turn at a time: `send` rejects if a turn is already submitted or
 * streaming. Read the latest projection via the `snapshot` getter, observe
 * changes with `subscribe`, register lifecycle hooks with `setCallbacks`,
 * abort the in-flight turn with `stop`, and discard all state with `reset`.
 */
export class EveAgentStore<TData> {
  readonly #createSession: (() => ClientSession) | undefined;
  readonly #optimistic: boolean;
  readonly #reducer: EveAgentReducer<TData>;
  readonly #subscribers = new Set<() => void>();

  #abortController: AbortController | undefined;
  #callbacks: EveAgentStoreCallbacks<TData> = {};
  #data: TData;
  #error: Error | undefined;
  #events: readonly HandleMessageStreamEvent[];
  #operationId = 0;
  #pendingMessageSubmission: PendingMessageSubmission | undefined;
  #projectionEvents: readonly EveAgentReducerEvent[];
  #session: ClientSession;
  #snapshot: EveAgentStoreSnapshot<TData>;
  #status: EveAgentStoreStatus = "ready";

  constructor(init: EveAgentStoreInit<TData>) {
    this.#createSession = init.session
      ? undefined
      : () =>
          new Client({
            auth: init.auth,
            headers: init.headers,
            host: init.host ?? "",
            maxReconnectAttempts: init.maxReconnectAttempts,
          }).session(init.initialSession);
    this.#events = [...(init.initialEvents ?? [])];
    this.#projectionEvents = [...this.#events];
    this.#optimistic = init.optimistic ?? true;
    this.#reducer = init.reducer;
    this.#session = init.session ?? this.#createOwnedSession();

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
    if (this.#status === "streaming" || this.#status === "submitted") {
      throw new Error("eve session is already processing a turn.");
    }

    const operationId = this.#startOperation();
    const abortController = new AbortController();
    this.#abortController = abortController;
    this.#error = undefined;
    this.#status = "submitted";
    this.#publish();

    try {
      const preparedInput = (await this.#callbacks.prepareSend?.(input)) ?? input;

      if (!this.#isCurrentOperation(operationId)) {
        return;
      }

      this.#projectOptimisticMessage(preparedInput);
      this.#projectInputResponses(preparedInput);
      this.#publish();

      const response = await this.#session.send({
        ...preparedInput,
        signal: createAbortSignal(preparedInput.signal, abortController.signal),
      });

      let sawEvent = false;
      for await (const event of response) {
        if (!this.#isCurrentOperation(operationId)) {
          return;
        }

        if (!sawEvent) {
          sawEvent = true;
          this.#status = "streaming";
        }

        this.#events = [...this.#events, event];
        this.#applyServerEvent(event);
        this.#callbacks.onEvent?.(event);
        this.#applyTerminalStreamFailure(event);
        this.#publish();
      }

      if (!this.#isCurrentOperation(operationId)) {
        return;
      }

      this.#status = this.#error === undefined ? "ready" : "error";
    } catch (error) {
      if (!this.#isCurrentOperation(operationId)) {
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
      if (this.#isCurrentOperation(operationId)) {
        this.#abortController = undefined;
        this.#callbacks.onSessionChange?.(this.#session.state);
        this.#publish();
        this.#callbacks.onFinish?.(this.#snapshot);
      }
    }
  }

  stop(): void {
    this.#abortController?.abort();
  }

  reset(): void {
    this.#invalidateOperation();
    this.stop();
    this.#abortController = undefined;
    this.#session = this.#createSession?.() ?? this.#session;
    this.#events = [];
    this.#pendingMessageSubmission = undefined;
    this.#projectionEvents = [];
    this.#data = this.#reducer.initial();
    this.#error = undefined;
    this.#status = "ready";
    this.#callbacks.onSessionChange?.(this.#session.state);
    this.#publish();
  }

  #createOwnedSession(): ClientSession {
    if (!this.#createSession) {
      throw new Error("Cannot create an owned eve session from an external session.");
    }
    return this.#createSession();
  }

  #startOperation(): number {
    this.#operationId += 1;
    return this.#operationId;
  }

  #invalidateOperation(): void {
    this.#operationId += 1;
  }

  #isCurrentOperation(operationId: number): boolean {
    return this.#operationId === operationId;
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

  #applyServerEvent(event: HandleMessageStreamEvent): void {
    if (event.type === "message.received" && this.#pendingMessageSubmission !== undefined) {
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

    this.#appendProjectionEvent(event);
  }

  #applyTerminalStreamFailure(event: HandleMessageStreamEvent): void {
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
      session: this.#session.state,
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

let submissionSequence = 0;

function createSubmissionId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (randomUUID !== undefined) {
    return randomUUID.call(globalThis.crypto);
  }

  submissionSequence += 1;
  return `submission_${submissionSequence.toString()}`;
}

function createAbortSignal(first: AbortSignal | undefined, second: AbortSignal): AbortSignal {
  return first ? AbortSignal.any([first, second]) : second;
}

function summarizeUserContent(message: string | UserContent): string {
  if (typeof message === "string") {
    return message;
  }

  const parts: string[] = [];
  for (const part of message) {
    if (part.type === "text") {
      parts.push(part.text);
      continue;
    }

    if (part.type === "file") {
      parts.push(part.filename ? `[file: ${part.filename}]` : "[file]");
    }
  }

  return parts.join("\n");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function toTerminalStreamFailureError(event: HandleMessageStreamEvent): Error | undefined {
  if (event.type !== "session.failed") {
    return undefined;
  }

  const error = new Error(event.data.message);
  error.name = event.data.code;
  return error;
}
