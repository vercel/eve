import type { MessageStreamEvent } from "eve/client";

export const FANOUT_SIZE = 10;

/** A serialized executor cannot release the fixture tool's concurrency barrier. */
export function fanoutExecutionsReachBarrier(input: {
  readonly events: readonly MessageStreamEvent[];
  readonly labels: readonly string[];
  readonly toolName: string;
}): boolean {
  const executions = input.events.flatMap((event) => {
    if (event.type !== "action.result" || event.data.result.kind !== "tool-result") return [];
    if (event.data.result.toolName !== input.toolName) return [];

    const count = readFiniteNumberField(event.data.result.output, "concurrentCallsAtRelease");
    const label = readStringField(event.data.result.output, "label");
    return count === undefined || label === undefined ? [] : [{ count, label }];
  });
  const expectedLabels = new Set(input.labels);

  return (
    executions.length === FANOUT_SIZE &&
    executions.every((execution) => execution.count === FANOUT_SIZE) &&
    expectedLabels.size === FANOUT_SIZE &&
    new Set(executions.map((execution) => execution.label)).size === FANOUT_SIZE &&
    executions.every((execution) => expectedLabels.has(execution.label))
  );
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
