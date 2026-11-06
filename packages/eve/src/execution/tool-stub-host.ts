import type { ToolStubPlayback } from "#context/providers/tool-stubs-key.js";
import type { StubCall, StubResult, StubScope } from "#tool-stubs/types.js";

// How a host serves an eval's tool stubs. Stubs are an eval feature, so each host contract that
// meets them (`SessionHost`, `SessionStepHost` and `RunHost`) carries this one optional port, and
// a host without it refuses a stubbed session here, in one place.

/** A host's tool-stub service. Workflow's is `execution/workflow-host/tool-stubs.ts`. */
export interface ToolStubHost {
  /** Runs the root session `sessionId` while serving the stubs `scope` names to its calls. */
  serve<T>(scope: StubScope, sessionId: string, run: () => Promise<T>): Promise<T>;
  /** Answers one stubbed tool call. */
  call(scope: StubScope, call: StubCall): Promise<StubResult>;
  /** Records that a stubbed call's output failed to process. */
  fail(scope: StubScope, callId: string, error: string): Promise<void>;
}

function requireToolStubs(host: ToolStubHost | undefined): ToolStubHost {
  if (host === undefined) {
    throw new Error("This host can't serve tool stubs; run the stubbed eval on Workflow.");
  }
  return host;
}

/**
 * Runs a session's loop. The root of a stubbed eval serves its stubs while it runs; its child
 * sessions (whose scope names the root) and unstubbed sessions just run.
 */
export async function runServingToolStubs<T>(
  host: ToolStubHost | undefined,
  scope: StubScope | undefined,
  sessionId: string,
  run: () => Promise<T>,
): Promise<T> {
  if (scope === undefined || scope.rootSessionId !== undefined) return await run();
  return await requireToolStubs(host).serve(scope, sessionId, run);
}

/** Where a stubbed session's calls reach the stubs `scope` names, on `host`. */
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

/** One stubbed call from a workflow tool's run, on `host`. */
export async function callToolStub(
  host: ToolStubHost | undefined,
  scope: StubScope,
  call: StubCall,
): Promise<StubResult> {
  return await requireToolStubs(host).call(scope, call);
}
