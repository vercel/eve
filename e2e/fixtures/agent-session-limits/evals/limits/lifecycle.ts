import type { InputRequest, InputResponse } from "eve/client";
import type { EveEvalContext, EveEvalSession, EveEvalTurn } from "eve/evals";

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
  readonly turnId: string;
}

const ACTIVE = process.env.EVE_HITL_LIFECYCLE_CONTRACT === "1";
const LIFECYCLE_TYPES = new Set([
  "input.dismissed",
  "input.responded",
  "input.response.pending",
  "input.response.rejected",
]);

export function gateLifecycle(t: EveEvalContext): void {
  if (!ACTIVE) t.skip("Session-limit lifecycle contract is not active yet.");
}

export function traceRequest(events: readonly unknown[], request: InputRequest): RequestTrace {
  const exposures = events.flatMap((value) => {
    const event = asEvent(value);
    if (event?.type !== "input.requested" || !Array.isArray(event.data.requests)) return [];
    return event.data.requests.some(
      (candidate) => asRecord(candidate)?.requestId === request.requestId,
    )
      ? [event.data]
      : [];
  });
  if (exposures.length !== 1) {
    throw new Error(`Expected one exposure for ${request.requestId}.`);
  }
  const data = exposures[0]!;
  if (
    typeof data.sequence !== "number" ||
    typeof data.stepIndex !== "number" ||
    typeof data.turnId !== "string"
  ) {
    throw new Error(`Invalid coordinates for ${request.requestId}.`);
  }
  return {
    callId: request.action.callId,
    requestId: request.requestId,
    sequence: data.sequence,
    stepIndex: data.stepIndex,
    turnId: data.turnId,
  };
}

export function exactTerminal(
  events: readonly unknown[],
  trace: RequestTrace,
  expected: { readonly optionId: string; readonly outcome: "continued" | "stopped" },
): boolean {
  const lifecycle = requestEvents(events, trace.requestId);
  if (lifecycle.length !== 1 || lifecycle[0]?.type !== "input.responded") return false;
  const data = lifecycle[0].data;
  const response = asRecord(data.response);
  return (
    matchesOwner(data, trace) &&
    typeof data.candidateId === "string" &&
    data.candidateId.length > 0 &&
    data.responder === null &&
    data.outcome === expected.outcome &&
    response?.requestId === trace.requestId &&
    response.optionId === expected.optionId
  );
}

export function exactDismissal(
  events: readonly unknown[],
  trace: RequestTrace,
  reason: "superseded",
): boolean {
  const lifecycle = requestEvents(events, trace.requestId);
  return (
    lifecycle.length === 1 &&
    lifecycle[0]?.type === "input.dismissed" &&
    matchesOwner(lifecycle[0].data, trace) &&
    lifecycle[0].data.reason === reason
  );
}

export function exactStaleRejection(events: readonly unknown[], trace: RequestTrace): boolean {
  const lifecycle = requestEvents(events, trace.requestId);
  return (
    lifecycle.length === 1 &&
    lifecycle[0]?.type === "input.response.rejected" &&
    matchesOwner(lifecycle[0].data, trace) &&
    lifecycle[0].data.reason === "stale" &&
    typeof lifecycle[0].data.candidateId === "string" &&
    lifecycle[0].data.responder === null
  );
}

export function noLifecycleEvents(events: readonly unknown[], trace: RequestTrace): boolean {
  return requestEvents(events, trace.requestId).length === 0;
}

export function exactOrder(
  events: readonly unknown[],
  selectors: readonly {
    readonly match?: (data: UnknownRecord) => boolean;
    readonly type: string;
  }[],
): boolean {
  let previous = -1;
  for (const selector of selectors) {
    const indexes = events.flatMap((value, index) => {
      const event = asEvent(value);
      return event?.type === selector.type &&
        (selector.match === undefined || selector.match(event.data))
        ? [index]
        : [];
    });
    if (indexes.length !== 1 || indexes[0]! <= previous) return false;
    previous = indexes[0]!;
  }
  return true;
}

export async function respond(
  session: EveEvalSession | EveEvalContext,
  response: InputResponse,
): Promise<EveEvalTurn> {
  return await session.respond([response]);
}

export async function sendCompound(
  t: EveEvalContext,
  input: { readonly inputResponses: readonly InputResponse[]; readonly message: string },
): Promise<{ readonly session: EveEvalContext; readonly turn: EveEvalTurn }> {
  const sessionId = t.sessionId;
  const state = t.state;
  if (sessionId === undefined || state === undefined) {
    throw new Error("Compound delivery requires an active eval session.");
  }

  const response = await t.target.fetch(`/eve/v1/session/${encodeURIComponent(sessionId)}`, {
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: t.signal,
  });
  if (!response.ok) {
    throw new Error(`Compound delivery failed (${String(response.status)}).`);
  }

  const live = t.target.watchTurn(sessionId, { startIndex: state.streamIndex });
  return { session: t, turn: await live.result() };
}

export function expectWaiting(turn: EveEvalTurn, sessionId: string): void {
  if (turn.sessionId !== sessionId) throw new Error("Follow-up changed session identity.");
  turn.event("session.waiting", { count: 1 });
  turn.notEvent("session.completed");
  turn.notEvent("session.failed");
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

function matchesOwner(data: UnknownRecord, trace: RequestTrace): boolean {
  return (
    data.requestId === trace.requestId &&
    data.scope === "owner" &&
    data.sequence === trace.sequence &&
    data.stepIndex === trace.stepIndex &&
    data.turnId === trace.turnId
  );
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
