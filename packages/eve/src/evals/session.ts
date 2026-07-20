import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import { createTextWithFileContent } from "#client/file-parts.js";
import type { Client } from "#client/client.js";
import type { ClientSession } from "#client/session.js";
import type {
  CancelSessionResult,
  SendTurnInput,
  SendTurnPayload,
  SessionState,
} from "#client/types.js";
import type { HandleMessageStreamEvent, TurnFailureStreamEvent } from "#protocol/message.js";
import { isCurrentTurnBoundaryEvent, isTurnFailureEvent } from "#protocol/message.js";
import {
  deriveResultStatus,
  extractCompletedMessage,
  extractInputRequests,
} from "#client/session-utils.js";
import { extractCompletedResult } from "#client/output-schema.js";
import type { InputRequest, InputResponse } from "#runtime/input/types.js";
import { deriveRunFacts } from "#evals/runner/derive-run-facts.js";
import { AssertionCollector } from "#evals/assertions/collector.js";
import { createOutputAssertions, createScopedAssertions } from "#evals/assertions/scoped.js";
import { EvalRequirementFailed } from "#evals/control-flow.js";
import { inputRequestMatches, matchesValue, toolCallMatches } from "#evals/match.js";
import type {
  EveEvalAssertions,
  EveEvalDerivedFacts,
  EveEvalLiveTurn,
  EveEvalOutputAssertions,
  EveEvalSession,
  EveEvalSessionResult,
  EveEvalStreamEvent,
  EveEvalToolCall,
  EveEvalTurn,
  EveEvalWaitForEventOptions,
} from "#evals/types.js";
import type { EveEvalInputRequestMatchOptions, EveEvalToolCallMatchOptions } from "#evals/match.js";

/* oxlint-disable typescript/no-unsafe-declaration-merging */

/**
 * Error thrown by {@link EveEvalTurn.expectOk} when a turn failed.
 */
export class EveEvalTurnFailedError extends Error {
  readonly event: TurnFailureStreamEvent | undefined;
  readonly turn: EveEvalTurn;

  constructor(turn: EveEvalTurn) {
    const event = turn.events.find(isTurnFailureEvent);
    const detail =
      event === undefined
        ? `turn ended with status "${turn.status}"`
        : `${event.type}: ${event.data.code} ${event.data.message}`.trim();
    super(`Eval turn failed: ${detail}`);
    this.name = "EveEvalTurnFailedError";
    this.event = event;
    this.turn = turn;
  }
}

export interface EvalSessionDriver extends EveEvalAssertions, EveEvalOutputAssertions {}

export class EvalSessionDriver implements EveEvalSession {
  readonly #session: ClientSession;
  readonly #signal: AbortSignal | undefined;
  readonly #collector: AssertionCollector;
  readonly #events: HandleMessageStreamEvent[] = [];
  #lastTurn: EvalTurn | undefined;
  #pendingInputRequests: readonly InputRequest[] = [];

  constructor(input: {
    readonly collector: AssertionCollector;
    readonly session: ClientSession;
    readonly signal?: AbortSignal;
  }) {
    this.#collector = input.collector;
    this.#session = input.session;
    this.#signal = input.signal;
    Object.assign(
      this,
      createScopedAssertions(this.#collector, {
        timing: "snapshot",
        select: () => this.#assertionSubject(),
      }),
      createOutputAssertions(this.#collector, {
        timing: "snapshot",
        select: () => this.#assertionSubject(),
      }),
    );
  }

  get events(): readonly HandleMessageStreamEvent[] {
    return this.#events;
  }

  get lastTurn(): EveEvalTurn | undefined {
    return this.#lastTurn;
  }

  get pendingInputRequests(): readonly InputRequest[] {
    return this.#pendingInputRequests;
  }

  get sessionId(): string | undefined {
    return this.#session.state.sessionId ?? this.#lastTurn?.sessionId;
  }

  get state(): SessionState {
    return this.#session.state;
  }

  async cancel(): Promise<CancelSessionResult> {
    return await this.#session.cancel();
  }

  requireInputRequest(filter: EveEvalInputRequestMatchOptions = {}): InputRequest {
    if (this.#pendingInputRequests.length === 0) {
      this.#failRequirement(
        "requireInputRequest",
        "expected one pending input request, but the last turn did not park",
      );
    }

    const matching = this.#pendingInputRequests.filter((request) =>
      inputRequestMatches(request, filter),
    );
    if (this.#pendingInputRequests.length !== 1 || matching.length !== 1) {
      this.#failRequirement(
        "requireInputRequest",
        `expected exactly one pending input request matching ${formatInputRequestFilter(filter)}, found ${matching.length} match(es) across ${this.#pendingInputRequests.length} pending request(s)`,
      );
    }

    this.#collector.recordOutcome({ name: "requireInputRequest", outcome: { score: 1 } });
    return matching[0]!;
  }

  async respond(...responses: InputResponse[]): Promise<EveEvalTurn> {
    if (responses.length === 0) {
      throw new Error("respond() requires at least one input response.");
    }

    return await this.send({ inputResponses: responses });
  }

  async respondAll(optionId: string): Promise<EveEvalTurn> {
    const requests = this.#pendingInputRequests;
    if (requests.length === 0) {
      throw new Error("respondAll() requires at least one pending input request.");
    }
    for (const request of requests) {
      assertRequestHasOption(request, optionId);
    }

    return await this.respond(
      ...requests.map((request) => ({
        optionId,
        requestId: request.requestId,
      })),
    );
  }

  async send(input: SendTurnInput): Promise<EveEvalTurn> {
    return await (await this.start(input)).result();
  }

  async start(input: SendTurnInput): Promise<EveEvalLiveTurn> {
    const response = await this.#session.send(attachSignal(input, this.#signal));
    return new EvalLiveTurn({
      events: response,
      record: (events) => this.#recordObservedTurn(response.sessionId, events),
      session: this,
      sessionId: response.sessionId,
    });
  }

  async sendFile(text: string, filePath: string, mediaType?: string): Promise<EveEvalTurn> {
    const bytes = await readFile(filePath);
    const message = createTextWithFileContent({
      bytes,
      filename: basename(filePath),
      mediaType: mediaType ?? inferMediaType(filePath),
      text,
    });
    return await this.send({ message });
  }

  async readTurn(options?: { readonly startIndex?: number }): Promise<EveEvalTurn> {
    const sessionId = this.sessionId;
    return await this.watchTurn(options, requireSessionId(sessionId)).result();
  }

  watchTurn(
    options?: { readonly startIndex?: number },
    sessionId = requireSessionId(this.sessionId),
  ): EveEvalLiveTurn {
    return new EvalLiveTurn({
      events: this.#session.stream({
        signal: this.#signal,
        startIndex: options?.startIndex,
      }),
      record: (events) => this.#recordObservedTurn(sessionId, events),
      session: this,
      sessionId,
    });
  }

  snapshot(primary: boolean): EveEvalSessionResult {
    const sessionId = this.sessionId;
    return {
      derived: deriveRunFacts(this.#events, { sessionId }),
      events: [...this.#events],
      primary,
      sessionId,
      state: this.#session.state,
    };
  }

  #recordTurn(input: {
    readonly data: unknown;
    readonly events: readonly HandleMessageStreamEvent[];
    readonly inputRequests: readonly InputRequest[];
    readonly message: string | undefined;
    readonly sessionId: string;
    readonly status: "completed" | "failed" | "waiting";
  }): EveEvalTurn {
    this.#events.push(...input.events);
    this.#pendingInputRequests = input.status === "waiting" ? input.inputRequests : [];

    const derived = deriveRunFacts(input.events, { sessionId: input.sessionId });
    const turn = new EvalTurn({
      collector: this.#collector,
      data: input.data,
      derived,
      events: input.events,
      inputRequests: input.inputRequests,
      message: input.message,
      sessionId: input.sessionId,
      status: input.status,
      toolCalls: derived.toolCalls,
    });
    this.#lastTurn = turn;
    return turn;
  }

  #recordObservedTurn(sessionId: string, events: readonly HandleMessageStreamEvent[]): EveEvalTurn {
    return this.#recordTurn({
      data: extractCompletedResult(events),
      events,
      inputRequests: extractInputRequests(events),
      message: extractCompletedMessage(events),
      sessionId,
      status: deriveResultStatus(events),
    });
  }

  #assertionSubject() {
    const sessionId = this.sessionId;
    const derived = deriveRunFacts(this.#events, { sessionId });
    return {
      derived,
      events: [...this.#events],
      output: outputOf(this.#lastTurn),
      status: this.#lastTurn?.status ?? "completed",
    } as const;
  }

  #failRequirement(name: string, message: string): never {
    this.#collector.recordOutcome({ name, outcome: { score: 0, message } });
    throw new EvalRequirementFailed();
  }
}

interface LiveEventWaiter {
  readonly matches: (event: HandleMessageStreamEvent) => boolean;
  readonly reject: (error: Error) => void;
  readonly resolve: (event: HandleMessageStreamEvent) => void;
}

class EvalLiveTurn implements EveEvalLiveTurn {
  readonly session: EveEvalSession;
  readonly sessionId: string;
  readonly #completion: Promise<EveEvalTurn>;
  readonly #events: HandleMessageStreamEvent[] = [];
  readonly #waiters = new Set<LiveEventWaiter>();
  #waitError: Error | undefined;

  constructor(input: {
    readonly events: AsyncIterable<HandleMessageStreamEvent>;
    readonly record: (events: readonly HandleMessageStreamEvent[]) => EveEvalTurn;
    readonly session: EveEvalSession;
    readonly sessionId: string;
  }) {
    this.session = input.session;
    this.sessionId = input.sessionId;
    this.#completion = this.#consume(input.events, input.record);
    void this.#completion.catch(() => {});
  }

  get events(): readonly HandleMessageStreamEvent[] {
    return this.#events;
  }

  async cancel(): Promise<CancelSessionResult> {
    return await this.session.cancel();
  }

  async result(): Promise<EveEvalTurn> {
    return await this.#completion;
  }

  async waitForEvent<TType extends HandleMessageStreamEvent["type"]>(
    type: TType,
    options?: EveEvalWaitForEventOptions<TType>,
  ): Promise<EveEvalStreamEvent<TType>> {
    const matches = (event: HandleMessageStreamEvent): boolean =>
      event.type === type &&
      (options?.data === undefined ||
        matchesValue(options.data, "data" in event ? event.data : undefined));
    const observed = this.#events.find(matches);
    if (observed !== undefined) return observed as EveEvalStreamEvent<TType>;
    if (this.#waitError !== undefined) throw this.#waitError;

    return await new Promise<EveEvalStreamEvent<TType>>((resolve, reject) => {
      const waiter: LiveEventWaiter = {
        matches,
        reject,
        resolve: (event) => resolve(event as EveEvalStreamEvent<TType>),
      };
      this.#waiters.add(waiter);
    });
  }

  async #consume(
    source: AsyncIterable<HandleMessageStreamEvent>,
    record: (events: readonly HandleMessageStreamEvent[]) => EveEvalTurn,
  ): Promise<EveEvalTurn> {
    try {
      let sawBoundary = false;
      for await (const event of source) {
        this.#events.push(event);
        this.#resolveWaiters(event);

        if (isTurnFailureEvent(event)) {
          this.#closeWaiters(
            new Error(
              `Session ${this.sessionId} failed before the expected event (${event.type}).`,
            ),
          );
        }

        if (isCurrentTurnBoundaryEvent(event)) {
          sawBoundary = true;
          this.#closeWaiters(
            new Error(`Session ${this.sessionId} reached ${event.type} before the expected event.`),
          );
          break;
        }
      }

      if (!sawBoundary) {
        throw new Error(`Stream for session "${this.sessionId}" closed before a turn boundary.`);
      }

      return record(this.#events);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.#closeWaiters(normalized);
      throw error;
    }
  }

  #resolveWaiters(event: HandleMessageStreamEvent): void {
    for (const waiter of this.#waiters) {
      if (!waiter.matches(event)) continue;
      this.#waiters.delete(waiter);
      waiter.resolve(event);
    }
  }

  #closeWaiters(error: Error): void {
    if (this.#waitError !== undefined) return;
    this.#waitError = error;
    for (const waiter of this.#waiters) {
      waiter.reject(error);
    }
    this.#waiters.clear();
  }
}

interface EvalTurn extends EveEvalAssertions, EveEvalOutputAssertions {}

class EvalTurn implements EveEvalTurn {
  readonly data: unknown;
  readonly events: readonly HandleMessageStreamEvent[];
  readonly inputRequests: readonly InputRequest[];
  readonly message: string | undefined;
  readonly sessionId: string;
  readonly status: "completed" | "failed" | "waiting";
  readonly toolCalls: readonly EveEvalToolCall[];
  readonly #collector: AssertionCollector;
  readonly #derived: EveEvalDerivedFacts;

  constructor(input: {
    readonly collector: AssertionCollector;
    readonly data: unknown;
    readonly derived: EveEvalDerivedFacts;
    readonly events: readonly HandleMessageStreamEvent[];
    readonly inputRequests: readonly InputRequest[];
    readonly message: string | undefined;
    readonly sessionId: string;
    readonly status: "completed" | "failed" | "waiting";
    readonly toolCalls: readonly EveEvalToolCall[];
  }) {
    this.data = input.data;
    this.events = input.events;
    this.inputRequests = input.inputRequests;
    this.message = input.message;
    this.sessionId = input.sessionId;
    this.status = input.status;
    this.toolCalls = input.toolCalls;
    this.#collector = input.collector;
    this.#derived = input.derived;
    Object.assign(
      this,
      createScopedAssertions(input.collector, {
        timing: "snapshot",
        select: () => this.#assertionSubject(),
      }),
      createOutputAssertions(input.collector, {
        timing: "snapshot",
        select: () => this.#assertionSubject(),
      }),
    );
  }

  expectOk(): this {
    if (this.status !== "failed") return this;
    throw new EveEvalTurnFailedError(this);
  }

  requireToolCall(
    name: string,
    options: Omit<EveEvalToolCallMatchOptions, "count"> = {},
  ): EveEvalToolCall {
    const matching = this.toolCalls.filter(
      (call) => call.name === name && toolCallMatches(call, options),
    );
    if (matching.length !== 1) {
      inputRequirementFailed(
        this.#collector,
        "requireToolCall",
        `expected exactly one matching "${name}" tool call in this turn, found ${matching.length}; observed [${this.toolCalls.map((call) => call.name).join(", ")}]`,
      );
    }
    this.#collector.recordOutcome({ name: "requireToolCall", outcome: { score: 1 } });
    return matching[0]!;
  }

  #assertionSubject() {
    return {
      derived: this.#derived,
      events: this.events,
      output: outputOf(this),
      status: this.status,
    } as const;
  }
}

export class EvalSessionManager {
  readonly #client: Client;
  readonly #signal: AbortSignal | undefined;
  readonly #collector: AssertionCollector;
  readonly #sessions: EvalSessionDriver[] = [];
  #primary: EvalSessionDriver | undefined;

  constructor(input: {
    readonly client: Client;
    readonly collector?: AssertionCollector;
    readonly signal?: AbortSignal;
  }) {
    this.#client = input.client;
    this.#collector = input.collector ?? new AssertionCollector();
    this.#signal = input.signal;
  }

  get primary(): EvalSessionDriver {
    this.#primary ??= this.#createSession();
    return this.#primary;
  }

  newSession(): EvalSessionDriver {
    return this.#createSession();
  }

  async attachSession(
    sessionId: string,
    options?: { readonly startIndex?: number },
  ): Promise<EvalSessionDriver> {
    const session = this.#createAttachedSession(sessionId, options);
    await session.readTurn(options);
    return session;
  }

  watchTurn(sessionId: string, options?: { readonly startIndex?: number }): EveEvalLiveTurn {
    return this.#createAttachedSession(sessionId, options).watchTurn(options, sessionId);
  }

  snapshots(): readonly EveEvalSessionResult[] {
    return this.#sessions.map((session) => session.snapshot(session === this.#primary));
  }

  lastTurnSession(): EvalSessionDriver | undefined {
    if (this.#primary?.lastTurn !== undefined) {
      return this.#primary;
    }

    return this.#sessions.find((session) => session.lastTurn !== undefined);
  }

  hasActivity(): boolean {
    return this.#sessions.length > 0;
  }

  #createSession(): EvalSessionDriver {
    const session = new EvalSessionDriver({
      collector: this.#collector,
      session: this.#client.session(),
      signal: this.#signal,
    });
    this.#sessions.push(session);
    return session;
  }

  #createAttachedSession(
    sessionId: string,
    options?: { readonly startIndex?: number },
  ): EvalSessionDriver {
    const session = new EvalSessionDriver({
      collector: this.#collector,
      session: this.#client.session({ sessionId, streamIndex: options?.startIndex ?? 0 }),
      signal: this.#signal,
    });
    this.#sessions.push(session);
    return session;
  }
}

function attachSignal(input: SendTurnInput, signal: AbortSignal | undefined): SendTurnInput {
  if (signal === undefined) return input;

  if (typeof input === "string") {
    return { message: input, signal };
  }

  const payload = input as SendTurnPayload;
  return payload.signal === undefined ? { ...payload, signal } : payload;
}

function formatInputRequestFilter(filter: EveEvalInputRequestMatchOptions): string {
  return JSON.stringify(filter);
}

function inputRequirementFailed(
  collector: AssertionCollector,
  name: string,
  message: string,
): never {
  collector.recordOutcome({ name, outcome: { score: 0, message } });
  throw new EvalRequirementFailed();
}

function outputOf(turn: EveEvalTurn | undefined): unknown {
  if (turn === undefined) return null;
  return turn.data === undefined ? (turn.message ?? null) : turn.data;
}

function requireSessionId(sessionId: string | undefined): string {
  if (sessionId === undefined) {
    throw new Error("Eval session produced a turn without a session id.");
  }
  return sessionId;
}

function assertRequestHasOption(request: InputRequest, optionId: string): void {
  if (request.options === undefined || request.options.length === 0) {
    throw new Error(`Input request "${request.requestId}" has no selectable options.`);
  }

  if (!request.options.some((option) => option.id === optionId)) {
    throw new Error(`Input request "${request.requestId}" does not offer option "${optionId}".`);
  }
}

function inferMediaType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".gif":
      return "image/gif";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}
