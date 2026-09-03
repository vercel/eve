import type { RunInput, SessionTraceContext } from "#channel/types.js";

export interface InternalRunInput extends RunInput {
  readonly traceSeed?: SessionTraceContext;
}

export function readInternalTraceSeed(input: RunInput): SessionTraceContext | undefined {
  return (input as InternalRunInput).traceSeed;
}
