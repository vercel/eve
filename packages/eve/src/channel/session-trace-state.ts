import type { TraceCoordinates } from "#protocol/agent-invocation-trace.js";

const acceptedTraceCoordinates = new WeakMap<object, TraceCoordinates>();

export function attachAcceptedTraceCoordinates<T extends object>(
  target: T,
  trace: TraceCoordinates | undefined,
): T {
  if (trace !== undefined) acceptedTraceCoordinates.set(target, trace);
  return target;
}

export function readAcceptedTraceCoordinates(target: object): TraceCoordinates | undefined {
  return acceptedTraceCoordinates.get(target);
}

export function copyAcceptedTraceCoordinates<T extends object>(source: object, target: T): T {
  return attachAcceptedTraceCoordinates(target, acceptedTraceCoordinates.get(source));
}
