import type { HandleMessageStreamEvent } from "eve/client";

export const FANOUT_SIZE = 10;

interface RequestedToolCall {
  readonly callId: string;
  readonly eventIndex: number;
  readonly input: unknown;
}

/**
 * Checks the visible fan-out boundary: every requested call must have reached
 * the stream before the first matching result. This is the observable provider
 * contract; the provider's own network execution is outside eve's process.
 */
export function fanoutRequestsPrecedeFirstResult(input: {
  readonly events: readonly HandleMessageStreamEvent[];
  readonly toolName: string;
}): boolean {
  const requests = requestedToolCalls(input);
  const firstResultIndex = input.events.findIndex(
    (event) =>
      event.type === "action.result" &&
      event.data.result.kind === "tool-result" &&
      event.data.result.toolName === input.toolName,
  );

  return (
    firstResultIndex >= 0 &&
    requests.length === FANOUT_SIZE &&
    new Set(requests.map((request) => request.callId)).size === FANOUT_SIZE &&
    requests.every((request) => request.eventIndex < firstResultIndex)
  );
}

export function fanoutRequestsUseExpectedLabels(input: {
  readonly events: readonly HandleMessageStreamEvent[];
  readonly labels: readonly string[];
  readonly toolName: string;
}): boolean {
  const labels = requestedToolCalls(input)
    .map((request) => readStringField(request.input, "label"))
    .filter((label): label is string => label !== undefined);
  const expectedLabels = new Set(input.labels);

  return (
    labels.length === FANOUT_SIZE &&
    expectedLabels.size === FANOUT_SIZE &&
    new Set(labels).size === FANOUT_SIZE &&
    labels.every((label) => expectedLabels.has(label))
  );
}

/**
 * The fixture tool holds each invocation open. Requiring every interval to
 * overlap rules out a serialized executor without relying on a clock-skew
 * threshold.
 */
export function authoredFanoutExecutionsOverlap(input: {
  readonly events: readonly HandleMessageStreamEvent[];
  readonly toolName: string;
}): boolean {
  const intervals: Array<{ readonly completedAt: number; readonly startedAt: number }> = [];

  for (const event of input.events) {
    if (event.type !== "action.result" || event.data.result.kind !== "tool-result") continue;
    if (event.data.result.toolName !== input.toolName) continue;

    const startedAt = readFiniteNumberField(event.data.result.output, "executionStartedAt");
    const completedAt = readFiniteNumberField(event.data.result.output, "executionCompletedAt");
    if (startedAt === undefined || completedAt === undefined || startedAt >= completedAt) {
      return false;
    }
    intervals.push({ completedAt, startedAt });
  }

  return (
    intervals.length === FANOUT_SIZE &&
    Math.max(...intervals.map((interval) => interval.startedAt)) <
      Math.min(...intervals.map((interval) => interval.completedAt))
  );
}

function requestedToolCalls(input: {
  readonly events: readonly HandleMessageStreamEvent[];
  readonly toolName: string;
}): RequestedToolCall[] {
  return input.events.flatMap((event, eventIndex) => {
    if (event.type !== "actions.requested") return [];

    return event.data.actions.flatMap((action) => {
      if (action.kind !== "tool-call" || action.toolName !== input.toolName) return [];
      return [{ callId: action.callId, eventIndex, input: action.input }];
    });
  });
}

function readFiniteNumberField(value: unknown, field: string): number | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

  const candidate = Reflect.get(value, field);
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function readStringField(value: unknown, field: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

  const candidate = Reflect.get(value, field);
  return typeof candidate === "string" ? candidate : undefined;
}
