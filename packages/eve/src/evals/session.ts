import type { SessionStreamEvent } from "#protocol/session-event.js";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { createTextWithFileContent } from "#client/file-parts.js";
import type { ClientSession } from "#client/session.js";
import type {
  CancelSessionResult,
  ClientSessionState,
  SendTurnInput,
  SendTurnOptions,
  SendTurnPayload,
  StreamOptions,
} from "#client/types.js";
import type { RuntimeTraceContext } from "#protocol/message.js";
import type { ChildOpened } from "#protocol/session-events/families/child.js";
import { failureOf, ResponseSegment, summarizeTurnEvents } from "#client/session-utils.js";
import { extractCompletedResult } from "#client/output-schema.js";
import type { InputRequest, InputResponse } from "#shared/input.js";
import { deriveRunFacts } from "#evals/runner/derive-run-facts.js";
import { formatEvalTranscript, inferMediaType } from "#evals/session-content.js";
import { AssertionCollector } from "#evals/assertions/collector.js";
import { createOutputAssertions, createScopedAssertions } from "#evals/assertions/scoped.js";
import { EvalRequirementFailed } from "#evals/control-flow.js";
import { inputRequestMatches, matchesValue, toolCallMatches } from "#evals/match.js";
import type {
  EveEvalAgentSession,
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
import { assertReportedToolName } from "#evals/reported-tool-name.js";

/* oxlint-disable typescript/no-unsafe-declaration-merging */

/**
 * Error thrown by {@link EveEvalTurn.expectOk} when a turn failed.
 */
export class EveEvalTurnFailedError extends Error {
  /** The `turn.settled` or `session.ended` that reported the failure. */
  readonly event: SessionStreamEvent | undefined;
  readonly turn: EveEvalTurn;

  constructor(turn: EveEvalTurn) {
    const event = turn.events.find((candidate) => failureOf(candidate) !== undefined);
    const error = event === undefined ? undefined : failureOf(event);
    const detail =
      event === undefined || error === undefined
        ? `turn ended with status "${turn.status}"`
        : `${event.type}: ${error.code} ${error.message}`.trim();
    super(`Eval turn failed: ${detail}`);
    this.name = "EveEvalTurnFailedError";
    this.event = event;
    this.turn = turn;
  }
}

export interface EvalSessionDriver extends EveEvalAssertions, EveEvalOutputAssertions {}

export interface EvalSessionStartedEvent {
  readonly primary: boolean;
  readonly sessionId: string;
  readonly startedAt: string;
  readonly traceContext: RuntimeTraceContext;
}

export class EvalSessionDriver implements EveEvalSession {
  readonly #session: ClientSession;
  readonly #onTurn: (session: EvalSessionDriver) => void;
  #lastInput = "";
  readonly #signal: AbortSignal | undefined;
  readonly #collector: AssertionCollector;
  readonly #events: SessionStreamEvent[] = [];
  readonly #primary: boolean;
  readonly #onSessionStart: ((event: EvalSessionStartedEvent) => void) | undefined;
  readonly #traceContexts: RuntimeTraceContext[] = [];
  readonly #traceKeys = new Set<string>();
  #lastTurn: EvalTurn | undefined;
  #sessionStartReported = false;
  #pendingInputRequests: readonly InputRequest[] = [];

  constructor(input: {
    readonly collector: AssertionCollector;
    readonly onSessionStart?: (event: EvalSessionStartedEvent) => void;
    readonly primary: boolean;
    readonly session: ClientSession;
    readonly onTurn: (session: EvalSessionDriver) => void;
    readonly signal?: AbortSignal;
  }) {
    this.#collector = input.collector;
    this.#onSessionStart = input.onSessionStart;
    this.#primary = input.primary;
    this.#session = input.session;
    this.#onTurn = input.onTurn;
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

  get events(): readonly SessionStreamEvent[] {
    return this.#events;
  }

  get transcript(): string {
    return formatEvalTranscript(this.#events);
  }

  get lastInput(): string {
    return this.#lastInput;
  }

  get lastTurn(): EveEvalTurn | undefined {
    return this.#lastTurn;
  }

  get pendingInputRequests(): readonly InputRequest[] {
    return this.#pendingInputRequests;
  }

  get sessionId(): string {
    return this.#session.state.sessionId;
  }

  get state(): ClientSessionState {
    return this.#session.state;
  }

  async cancel(): Promise<CancelSessionResult> {
    return await this.#session.cancel();
  }

  async compact(): Promise<EveEvalTurn> {
    const result = await this.#session.compact();
    if (result.status !== "accepted") {
      throw new Error(`compact() found no active session for "${this.sessionId}".`);
    }
    return await this.readTurn();
  }

  agent(opened: ChildOpened): EveEvalAgentSession {
    const child = this.#session.agent(opened);
    const signal = this.#signal;
    return {
      name: child.name,
      sessionId: child.sessionId,
      stream: (options: StreamOptions = {}) =>
        child.stream({ ...options, signal: options.signal ?? signal }),
      taskId: child.taskId,
    };
  }

  /** @internal */
  async cleanup(signal: AbortSignal): Promise<void> {
    await this.#session.reset({ reason: "Eval timed out", signal });
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

  async respond(
    responses: readonly InputResponse[],
    options: SendTurnOptions = {},
  ): Promise<EveEvalTurn> {
    if (responses.length === 0) {
      throw new Error("respond() requires at least one input response.");
    }

    return await (await this.#start({ ...options, inputResponses: responses })).result();
  }

  async startRespond(
    responses: readonly InputResponse[],
    options: SendTurnOptions = {},
  ): Promise<EveEvalLiveTurn> {
    if (responses.length === 0) throw new Error("startRespond() requires input responses.");
    return await this.#start({ ...options, inputResponses: responses });
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
      requests.map((request) => ({
        optionId,
        requestId: request.requestId,
      })),
    );
  }

  async send(
    message: SendTurnInput["message"],
    options: SendTurnOptions = {},
  ): Promise<EveEvalTurn> {
    return await (await this.#start({ turnPolicy: "queue", ...options, message })).result();
  }

  async start(message: string, options: SendTurnOptions = {}): Promise<EveEvalLiveTurn> {
    return await this.#start({ turnPolicy: "queue", ...options, message });
  }

  async #start(input: SendTurnPayload): Promise<EveEvalLiveTurn> {
    const { inputResponses, message, ...options } = attachSignal(input, this.#signal);
    const response =
      inputResponses === undefined
        ? await this.#session.send(message!, options)
        : await this.#session.respond(inputResponses, options);
    return this.consume(response, message);
  }

  /** @internal */
  consume(
    events: AsyncIterable<SessionStreamEvent>,
    message?: SendTurnInput["message"],
  ): EveEvalLiveTurn {
    const sessionId = this.sessionId;
    return new EvalLiveTurn({
      events,
      observe: (event) => this.#observeEvent(sessionId, event),
      record: (observed) => {
        if (message !== undefined) {
          this.#lastInput =
            typeof message === "string"
              ? message
              : message
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n");
        }
        return this.#recordObservedTurn(sessionId, observed);
      },
      session: this,
      sessionId,
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
    return await this.send(message);
  }

  async readTurn(options?: { readonly startIndex?: number }): Promise<EveEvalTurn> {
    return await this.watchTurn(options).result();
  }

  watchTurn(options?: { readonly startIndex?: number }): EveEvalLiveTurn {
    return this.consume(
      this.#session.stream({ signal: this.#signal, startIndex: options?.startIndex }),
    );
  }

  snapshot(): EveEvalSessionResult {
    const sessionId = this.sessionId;
    return {
      derived: deriveRunFacts(this.#events, { sessionId }),
      events: [...this.#events],
      primary: this.#primary,
      sessionId,
      state: this.#session.state,
      traceContexts: [...this.#traceContexts],
    };
  }

  #observeEvent(sessionId: string, event: SessionStreamEvent): void {
    if (event.type !== "session.started" && event.type !== "turn.started") return;
    const traceContext = event.data.trace;
    if (traceContext === undefined) return;

    const key = `${traceContext.traceId}:${traceContext.spanId}`;
    if (this.#traceKeys.has(key)) return;
    this.#traceKeys.add(key);
    this.#traceContexts.push(traceContext);

    if (this.#sessionStartReported) return;
    this.#sessionStartReported = true;
    this.#onSessionStart?.({
      primary: this.#primary,
      sessionId,
      startedAt: event.meta.at,
      traceContext,
    });
  }

  #recordTurn(input: {
    readonly data: unknown;
    readonly events: readonly SessionStreamEvent[];
    readonly inputRequests: readonly InputRequest[];
    readonly message: string | undefined;
    readonly sessionId: string;
    readonly status: "completed" | "failed" | "waiting";
  }): EveEvalTurn {
    this.#events.push(...input.events);
    this.#pendingInputRequests = input.status === "waiting" ? input.inputRequests : [];

    const derived = deriveRunFacts(input.events, {
      sessionId: input.sessionId,
      usageEvents: this.#events,
    });
    const turn = new EvalTurn({
      collector: this.#collector,
      data: input.data,
      derived,
      events: input.events,
      inputRequests: input.inputRequests,
      message: input.message,
      session: this,
      sessionId: input.sessionId,
      status: input.status,
      toolCalls: derived.toolCalls,
    });
    this.#lastTurn = turn;
    this.#onTurn(this);
    return turn;
  }

  #recordObservedTurn(sessionId: string, events: readonly SessionStreamEvent[]): EveEvalTurn {
    const summary = summarizeTurnEvents(events);
    return this.#recordTurn({
      data: extractCompletedResult(events),
      events,
      inputRequests: summary.inputRequests,
      message: summary.message,
      sessionId,
      status: summary.status,
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
  readonly matches: (event: SessionStreamEvent) => boolean;
  readonly reject: (error: Error) => void;
  readonly resolve: (event: SessionStreamEvent) => void;
}

class EvalLiveTurn implements EveEvalLiveTurn {
  readonly session: EveEvalSession;
  readonly sessionId: string;
  readonly #completion: Promise<EveEvalTurn>;
  readonly #events: SessionStreamEvent[] = [];
  readonly #waiters = new Set<LiveEventWaiter>();
  #waitError: Error | undefined;

  constructor(input: {
    readonly events: AsyncIterable<SessionStreamEvent>;
    readonly observe: (event: SessionStreamEvent) => void;
    readonly record: (events: readonly SessionStreamEvent[]) => EveEvalTurn;
    readonly session: EveEvalSession;
    readonly sessionId: string;
  }) {
    this.session = input.session;
    this.sessionId = input.sessionId;
    this.#completion = this.#consume(input.events, input.observe, input.record);
    void this.#completion.catch(() => {});
  }

  get events(): readonly SessionStreamEvent[] {
    return this.#events;
  }

  async cancel(): Promise<CancelSessionResult> {
    return await this.session.cancel();
  }

  async result(): Promise<EveEvalTurn> {
    return await this.#completion;
  }

  async waitForEvent<TType extends SessionStreamEvent["type"]>(
    type: TType,
    options?: EveEvalWaitForEventOptions<TType>,
  ): Promise<EveEvalStreamEvent<TType>> {
    const matches = (event: SessionStreamEvent): boolean =>
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
    source: AsyncIterable<SessionStreamEvent>,
    observe: (event: SessionStreamEvent) => void,
    record: (events: readonly SessionStreamEvent[]) => EveEvalTurn,
  ): Promise<EveEvalTurn> {
    try {
      let sawBoundary = false;
      const segment = new ResponseSegment();
      for await (const event of source) {
        this.#events.push(event);
        const endsSegment = segment.observe(event);
        observe(event);
        this.#resolveWaiters(event);

        if (failureOf(event) !== undefined) {
          this.#closeWaiters(
            new Error(
              `Session ${this.sessionId} failed before the expected event (${event.type}).`,
            ),
          );
        }

        if (endsSegment) {
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

  #resolveWaiters(event: SessionStreamEvent): void {
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
  readonly events: readonly SessionStreamEvent[];
  readonly inputRequests: readonly InputRequest[];
  readonly message: string | undefined;
  readonly session: EveEvalSession;
  readonly sessionId: string;
  readonly status: "completed" | "failed" | "waiting";
  readonly toolCalls: readonly EveEvalToolCall[];
  readonly #collector: AssertionCollector;
  readonly #derived: EveEvalDerivedFacts;

  constructor(input: {
    readonly collector: AssertionCollector;
    readonly data: unknown;
    readonly derived: EveEvalDerivedFacts;
    readonly events: readonly SessionStreamEvent[];
    readonly inputRequests: readonly InputRequest[];
    readonly message: string | undefined;
    readonly session: EveEvalSession;
    readonly sessionId: string;
    readonly status: "completed" | "failed" | "waiting";
    readonly toolCalls: readonly EveEvalToolCall[];
  }) {
    this.data = input.data;
    this.events = input.events;
    this.inputRequests = input.inputRequests;
    this.message = input.message;
    this.sessionId = input.sessionId;
    this.session = input.session;
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
    assertReportedToolName(name, this.#collector.tools);
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

function attachSignal(input: SendTurnPayload, signal: AbortSignal | undefined): SendTurnPayload {
  if (signal === undefined) return input;
  return input.signal === undefined ? { ...input, signal } : input;
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

function assertRequestHasOption(request: InputRequest, optionId: string): void {
  if (request.options === undefined || request.options.length === 0) {
    throw new Error(`Input request "${request.requestId}" has no selectable options.`);
  }

  if (!request.options.some((option) => option.id === optionId)) {
    throw new Error(`Input request "${request.requestId}" does not offer option "${optionId}".`);
  }
}
