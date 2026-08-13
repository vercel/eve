import type { InputRequest } from "eve/client";
import type { EveEvalTurn } from "eve/evals";

type UnknownRecord = Readonly<Record<string, unknown>>;

interface StructuralEvent {
  readonly data: UnknownRecord;
  readonly type: string;
}

export interface RequestTrace {
  readonly callId: string;
  readonly requestId: string;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly toolName: string;
  readonly turnId: string;
}

export interface EventSelector {
  readonly actionCallId?: string;
  readonly match?: (data: UnknownRecord) => boolean;
  readonly requestId?: string;
  readonly type: string;
}

type RespondedOutcome = "allowed" | "answered" | "cancelled" | "continued" | "denied" | "stopped";

export interface ResponderExpectation {
  readonly authenticator: string;
  readonly issuer?: string;
  readonly principalId: string;
}

type TerminalExpectation =
  | {
      readonly optionId: string;
      readonly outcome: RespondedOutcome;
      readonly responder: ResponderExpectation | null;
      readonly type: "responded";
    }
  | {
      readonly reason: "cancelled" | "route-lost" | "session-ended" | "superseded";
      readonly type: "dismissed";
    };

const LIFECYCLE_TYPES = new Set([
  "input.dismissed",
  "input.responded",
  "input.response.pending",
  "input.response.rejected",
]);

/** Requires the follow-up to leave this same session waiting for another user delivery. */
export function expectFollowUpSessionActive(turn: EveEvalTurn, sessionId: string): void {
  if (turn.sessionId !== sessionId) {
    throw new Error(`Follow-up moved from session ${sessionId} to ${turn.sessionId}.`);
  }
  turn.eventsSatisfy("follow-up leaves the session active", (events) => {
    const waiting = events.filter((event) => event.type === "session.waiting");
    return (
      waiting.length === 1 &&
      waiting[0]?.data.wait === "next-user-message" &&
      waiting[0].data.continuationToken.length > 0 &&
      events.every((event) => event.type !== "session.completed" && event.type !== "session.failed")
    );
  });
}

export async function verifyFollowUpTurn(
  session: { send(message: string): Promise<EveEvalTurn> },
  sessionId: string,
  marker: string,
): Promise<EveEvalTurn> {
  const followUp = await session.send(
    `Do not call any tools. Reply with exactly ${marker} and nothing else.`,
  );
  followUp.expectOk();
  expectFollowUpSessionActive(followUp, sessionId);
  followUp.event("message.received", { count: 1 });
  followUp.event("message.completed", { count: 1 });
  followUp.messageIncludes(marker);
  followUp.usedNoTools();
  followUp.succeeded();
  return followUp;
}

export function requireRequest(
  requests: readonly InputRequest[],
  expected: { readonly optionIds?: readonly string[]; readonly toolName: string },
): InputRequest {
  const matches = requests.filter((request) => {
    if (request.action.toolName !== expected.toolName) return false;
    if (expected.optionIds === undefined) return true;
    const optionIds = request.options?.map((option: { readonly id: string }) => option.id) ?? [];
    return (
      optionIds.length === expected.optionIds.length &&
      optionIds.every((optionId: string, index: number) => optionId === expected.optionIds?.[index])
    );
  });
  if (matches.length !== 1) {
    throw new Error(
      `Expected one ${expected.toolName} request, found ${String(matches.length)} across ${String(requests.length)} requests.`,
    );
  }
  return matches[0]!;
}

/** Captures the request's action identity and originating turn coordinates exactly once. */
export function traceRequest(events: readonly unknown[], request: InputRequest): RequestTrace {
  const matches = events.flatMap((value) => {
    const event = asEvent(value);
    if (event?.type !== "input.requested" || !Array.isArray(event.data.requests)) return [];
    return event.data.requests.some(
      (candidate) => asRecord(candidate)?.requestId === request.requestId,
    )
      ? [event.data]
      : [];
  });
  if (matches.length !== 1) {
    throw new Error(
      `Expected request ${request.requestId} in one input.requested event, found ${String(matches.length)}.`,
    );
  }

  const coordinates = readCoordinates(matches[0]!);
  if (coordinates === undefined) {
    throw new Error(`Request ${request.requestId} has invalid originating coordinates.`);
  }

  return {
    ...coordinates,
    callId: request.action.callId,
    requestId: request.requestId,
    toolName: request.action.toolName,
  };
}

/** Requires one terminal winner across both responded and dismissed event families. */
export function exactRequestTerminal(
  events: readonly unknown[],
  request: RequestTrace,
  expected: TerminalExpectation,
): boolean {
  const lifecycle = requestEvents(events, request.requestId);
  if (lifecycle.length !== 1) return false;
  const event = lifecycle[0]!;
  if (!matchesOwnerCoordinates(event.data, request)) return false;

  if (expected.type === "dismissed") {
    return event.type === "input.dismissed" && event.data.reason === expected.reason;
  }

  const response = asRecord(event.data.response);
  return (
    event.type === "input.responded" &&
    matchesResponseIdentity(event.data, expected.responder) &&
    event.data.outcome === expected.outcome &&
    response?.requestId === request.requestId &&
    response.optionId === expected.optionId
  );
}

export function exactRequestRejection(
  events: readonly unknown[],
  request: RequestTrace,
  reason: "candidate-cancelled" | "invalid" | "policy-failed" | "stale" | "unauthorized",
  responder: ResponderExpectation | null = null,
): boolean {
  const rejected = requestEvents(events, request.requestId);
  return (
    rejected.length === 1 &&
    rejected[0]!.type === "input.response.rejected" &&
    matchesOwnerCoordinates(rejected[0]!.data, request) &&
    matchesResponseIdentity(rejected[0]!.data, responder) &&
    rejected[0]!.data.reason === reason
  );
}

export function noRequestEvents(events: readonly unknown[], request: RequestTrace): boolean {
  return (
    requestEvents(events, request.requestId).length === 0 &&
    events.every((value) => {
      const event = asEvent(value);
      if (event?.type !== "input.requested" || !Array.isArray(event.data.requests)) return true;
      return event.data.requests.every(
        (candidate) => asRecord(candidate)?.requestId !== request.requestId,
      );
    })
  );
}

export function exactRequestExposure(events: readonly unknown[], request: RequestTrace): boolean {
  const exposures = events.flatMap((value) => {
    const event = asEvent(value);
    if (event?.type !== "input.requested" || !Array.isArray(event.data.requests)) return [];
    return event.data.requests.flatMap((candidate) => {
      const observed = asRecord(candidate);
      const action = asRecord(observed?.action);
      return observed?.requestId === request.requestId
        ? [{ action, data: event.data, observed }]
        : [];
    });
  });
  return (
    exposures.length === 1 &&
    matchesCoordinates(exposures[0]!.data, request) &&
    exposures[0]!.action?.callId === request.callId &&
    exposures[0]!.action?.toolName === request.toolName
  );
}

export function exactRequestActionResult(
  events: readonly unknown[],
  request: RequestTrace,
  expected: null | { readonly output?: string | RegExp; readonly status: string },
): boolean {
  const results = events.flatMap((value) => {
    const event = asEvent(value);
    if (event?.type !== "action.result") return [];
    const result = asRecord(event.data.result);
    return result?.callId === request.callId ? [{ data: event.data, result }] : [];
  });
  if (expected === null) return results.length === 0;
  if (results.length !== 1) return false;

  const observed = results[0]!;
  return (
    observed.data.status === expected.status &&
    observed.result.kind === "tool-result" &&
    observed.result.toolName === request.toolName &&
    matchesOutput(observed.result.output, expected.output)
  );
}

/** Requires every selected event exactly once and in the declared order. */
export function exactEventOrder(
  events: readonly unknown[],
  selectors: readonly EventSelector[],
): boolean {
  let previous = -1;
  for (const selector of selectors) {
    const indexes = events.flatMap((value, index) =>
      matchesSelector(value, selector) ? [index] : [],
    );
    if (indexes.length !== 1 || indexes[0]! <= previous) return false;
    previous = indexes[0]!;
  }
  return true;
}

function requestEvents(events: readonly unknown[], requestId: string): StructuralEvent[] {
  return events.flatMap((value) => {
    const event = asEvent(value);
    return event !== undefined &&
      LIFECYCLE_TYPES.has(event.type) &&
      event.data.requestId === requestId
      ? [event]
      : [];
  });
}

function matchesOwnerCoordinates(data: UnknownRecord, request: RequestTrace): boolean {
  return (
    data.requestId === request.requestId &&
    data.scope === "owner" &&
    matchesCoordinates(data, request)
  );
}

function matchesCoordinates(data: UnknownRecord, request: RequestTrace): boolean {
  return (
    data.sequence === request.sequence &&
    data.stepIndex === request.stepIndex &&
    data.turnId === request.turnId
  );
}

function matchesResponseIdentity(
  data: UnknownRecord,
  expected: ResponderExpectation | null,
): boolean {
  if (typeof data.candidateId !== "string" || data.candidateId.length === 0) return false;
  if (expected === null) return data.responder === null;
  const responder = asRecord(data.responder);
  return (
    responder?.authenticator === expected.authenticator &&
    responder.principalId === expected.principalId &&
    responder.issuer === expected.issuer
  );
}

function matchesSelector(value: unknown, selector: EventSelector): boolean {
  const event = asEvent(value);
  if (event?.type !== selector.type) return false;
  if (selector.requestId !== undefined && event.data.requestId !== selector.requestId) return false;
  if (selector.actionCallId !== undefined) {
    const result = asRecord(event.data.result);
    if (result?.callId !== selector.actionCallId) return false;
  }
  return selector.match === undefined || selector.match(event.data);
}

function matchesOutput(value: unknown, expected: string | RegExp | undefined): boolean {
  if (expected === undefined) return true;
  const serialized = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  if (typeof expected === "string") return serialized.includes(expected);
  expected.lastIndex = 0;
  return expected.test(serialized);
}

function readCoordinates(
  data: UnknownRecord,
): Pick<RequestTrace, "sequence" | "stepIndex" | "turnId"> | undefined {
  return Number.isInteger(data.sequence) &&
    Number.isInteger(data.stepIndex) &&
    typeof data.turnId === "string" &&
    data.turnId.length > 0
    ? {
        sequence: data.sequence as number,
        stepIndex: data.stepIndex as number,
        turnId: data.turnId,
      }
    : undefined;
}

function asEvent(value: unknown): StructuralEvent | undefined {
  const event = asRecord(value);
  const data = asRecord(event?.data);
  return typeof event?.type === "string" && data !== undefined
    ? { data, type: event.type }
    : undefined;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}
