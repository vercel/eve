import { ContextKey } from "#context/key.js";
import type { StubCall, StubResult } from "#tool-stubs/types.js";

/** Sends tool calls and failures to the workflow that tracks stub responses. */
export interface ToolStubPlayback {
  call(call: StubCall): Promise<StubResult>;
  fail(callId: string, error: string): Promise<void>;
}

export const ToolStubPlaybackKey = new ContextKey<ToolStubPlayback>("eve.toolStubPlayback");

/** Calls this step's stubs answered with an `endsTurn` response, by tool call id. */
export const EndingStubCallsKey = new ContextKey<Set<string>>("eve.endingStubCalls");
