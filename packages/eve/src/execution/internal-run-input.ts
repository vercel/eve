import type { RunInput, SessionTraceContext } from "#channel/types.js";
import type { TraceCoordinates } from "#protocol/agent-invocation-trace.js";

export interface InternalRunInput extends RunInput {
  readonly acceptedTraceCoordinates?: TraceCoordinates;
  readonly traceSeed?: SessionTraceContext;
}

export function readInternalTraceSeed(input: RunInput): SessionTraceContext | undefined {
  return (input as InternalRunInput).traceSeed;
}
