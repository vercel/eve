import type { ToolStubPlayback } from "#context/providers/tool-stubs-key.js";
import type { StubCall, StubResult, StubScope } from "#tool-stubs/types.js";

export interface ToolStubHost {
  serve<T>(scope: StubScope, sessionId: string, run: () => Promise<T>): Promise<T>;
  call(scope: StubScope, call: StubCall): Promise<StubResult>;
  fail(scope: StubScope, callId: string, error: string): Promise<void>;
}

function requireToolStubs(host: ToolStubHost | undefined): ToolStubHost {
  if (host === undefined) {
    throw new Error("This host can't serve tool stubs; run the stubbed eval on Workflow.");
  }
  return host;
}

export async function runServingToolStubs<T>(
  host: ToolStubHost | undefined,
  scope: StubScope | undefined,
  sessionId: string,
  run: () => Promise<T>,
): Promise<T> {
  if (scope === undefined || scope.rootSessionId !== undefined) return await run();
  return await requireToolStubs(host).serve(scope, sessionId, run);
}

export function toolStubPlayback(
  host: ToolStubHost | undefined,
  scope: StubScope,
): ToolStubPlayback {
  const stubs = requireToolStubs(host);
  return {
    call: (call) => stubs.call(scope, call),
    fail: (callId, error) => stubs.fail(scope, callId, error),
  };
}

export async function callToolStub(
  host: ToolStubHost | undefined,
  scope: StubScope,
  call: StubCall,
): Promise<StubResult> {
  return await requireToolStubs(host).call(scope, call);
}
