import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import { createTextWithFileContent } from "#client/file-parts.js";
import type { Client } from "#client/client.js";
import type { ClientSession } from "#client/session.js";
import type { SendTurnInput, SendTurnPayload, SessionState } from "#client/types.js";
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
import type {
  EveEvalSession,
  EveEvalSessionResult,
  EveEvalToolCall,
  EveEvalTurn,
} from "#evals/types.js";

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

export class EvalSessionDriver implements EveEvalSession {
  readonly #session: ClientSession;
  readonly #signal: AbortSignal | undefined;
  readonly #events: HandleMessageStreamEvent[] = [];
  #lastTurn: EvalTurn | undefined;
  #pendingInputRequests: readonly InputRequest[] = [];

  constructor(input: { readonly session: ClientSession; readonly signal?: AbortSignal }) {
    this.#session = input.session;
    this.#signal = input.signal;
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

  expectInputRequests(filter?: {
    readonly display?: InputRequest["display"];
    readonly toolName?: string;
  }): readonly InputRequest[] {
    if (this.#pendingInputRequests.length === 0) {
      throw new Error("Expected pending input requests, but the last turn did not park.");
    }

    const matching = this.#pendingInputRequests.filter((request) =>
      inputRequestMatches(request, filter),
    );
    if (matching.length === 0) {
      throw new Error(`No pending input requests matched ${formatInputRequestFilter(filter)}.`);
    }

    return matching;
  }

  async respond(...responses: InputResponse[]): Promise<EveEvalTurn> {
    if (responses.length === 0) {
      throw new Error("respond() requires at least one input response.");
    }

    return await this.send({ inputResponses: responses });
  }

  async respondAll(optionId: string): Promise<EveEvalTurn> {
    const requests = this.expectInputRequests();
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
    const response = await this.#session.send(attachSignal(input, this.#signal));
    const result = await response.result();
    return this.#recordTurn({
      data: result.data,
      events: result.events,
      inputRequests: result.inputRequests,
      message: result.message,
      sessionId: result.sessionId,
      status: result.status,
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
    const events: HandleMessageStreamEvent[] = [];
    let sawBoundary = false;

    for await (const event of this.#session.stream({
      signal: this.#signal,
      startIndex: options?.startIndex,
    })) {
      events.push(event);

      if (isCurrentTurnBoundaryEvent(event)) {
        sawBoundary = true;
        break;
      }
    }

    if (!sawBoundary) {
      throw new Error(
        `Stream for session "${this.sessionId ?? "(unknown)"}" closed before a turn boundary.`,
      );
    }

    return this.#recordTurn({
      data: extractCompletedResult(events),
      events,
      inputRequests: extractInputRequests(events),
      message: extractCompletedMessage(events),
      sessionId,
      status: deriveResultStatus(events),
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
    readonly sessionId: string | undefined;
    readonly status: "completed" | "failed" | "waiting";
  }): EveEvalTurn {
    this.#events.push(...input.events);
    this.#pendingInputRequests = input.status === "waiting" ? input.inputRequests : [];

    const derived = deriveRunFacts(input.events, { sessionId: input.sessionId });
    const turn = new EvalTurn({
      data: input.data,
      events: input.events,
      inputRequests: input.inputRequests,
      message: input.message,
      sessionId: input.sessionId ?? this.sessionId ?? "",
      status: input.status,
      toolCalls: derived.toolCalls,
    });
    this.#lastTurn = turn;
    return turn;
  }
}

class EvalTurn implements EveEvalTurn {
  readonly data: unknown;
  readonly events: readonly HandleMessageStreamEvent[];
  readonly inputRequests: readonly InputRequest[];
  readonly message: string | undefined;
  readonly sessionId: string;
  readonly status: "completed" | "failed" | "waiting";
  readonly toolCalls: readonly EveEvalToolCall[];

  constructor(input: {
    readonly data: unknown;
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
  }

  expectOk(): this {
    if (this.status !== "failed") return this;
    throw new EveEvalTurnFailedError(this);
  }
}

export class EvalSessionManager {
  readonly #client: Client;
  readonly #signal: AbortSignal | undefined;
  readonly #sessions: EvalSessionDriver[] = [];
  #primary: EvalSessionDriver | undefined;

  constructor(input: { readonly client: Client; readonly signal?: AbortSignal }) {
    this.#client = input.client;
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
    const session = new EvalSessionDriver({
      session: this.#client.session({ sessionId, streamIndex: options?.startIndex ?? 0 }),
      signal: this.#signal,
    });
    this.#sessions.push(session);
    await session.readTurn(options);
    return session;
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

  #createSession(): EvalSessionDriver {
    const session = new EvalSessionDriver({
      session: this.#client.session(),
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

function inputRequestMatches(
  request: InputRequest,
  filter: { readonly display?: InputRequest["display"]; readonly toolName?: string } | undefined,
): boolean {
  if (filter === undefined) return true;
  if (filter.display !== undefined && request.display !== filter.display) return false;
  if (filter.toolName !== undefined) {
    return request.action.kind === "tool-call" && request.action.toolName === filter.toolName;
  }
  return true;
}

function formatInputRequestFilter(
  filter: { readonly display?: InputRequest["display"]; readonly toolName?: string } | undefined,
): string {
  if (filter === undefined) return "{}";
  return JSON.stringify(filter);
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
