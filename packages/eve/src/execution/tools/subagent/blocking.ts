import type { SessionParent } from "#channel/types.js";
import type { DispatchOutcome } from "#execution/agent-handle-dispatch.js";
import {
  startSubagent,
  type DispatchStartTarget,
} from "#execution/dispatch-runtime-actions-shared.js";
import { buildSubagentRunInput } from "#execution/subagent-tool.js";
import {
  createSubagentToolRunSession,
  startSubagentToolRun,
} from "#execution/tools/subagent/run.js";
import type {
  RuntimeRemoteAgentCallActionRequest,
  RuntimeSubagentCallActionRequest,
} from "#shared/action-types.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";

/** Starts the shared execute run, then dispatches a blocking child to its private hook. */
export async function startBlockingSubagent(input: {
  readonly action: RuntimeRemoteAgentCallActionRequest | RuntimeSubagentCallActionRequest;
  readonly auth: Parameters<typeof buildSubagentRunInput>[0]["auth"];
  readonly batchEvent: { readonly sequence: number; readonly turnId: string };
  readonly bundle: CompiledBundle;
  readonly callbackBaseUrl: string | undefined;
  readonly capabilities: Parameters<typeof buildSubagentRunInput>[0]["capabilities"];
  readonly channelMetadata: Parameters<typeof buildSubagentRunInput>[0]["channelMetadata"];
  readonly currentSession: Parameters<typeof startSubagent>[0]["currentSession"];
  readonly fanoutSize: number;
  readonly initiatorAuth: Parameters<typeof buildSubagentRunInput>[0]["initiatorAuth"];
  readonly ownerToken: string;
  readonly parentSession: SessionParent | undefined;
  readonly parentTraceContext: Parameters<typeof buildSubagentRunInput>[0]["parentTraceContext"];
  readonly sandboxSessionId: string;
  readonly serializedContext: Record<string, unknown>;
  readonly session: Parameters<typeof startSubagent>[0]["session"];
  readonly stepIndex: number;
  readonly target: DispatchStartTarget;
}): Promise<{
  readonly outcome?: DispatchOutcome;
  readonly run: Awaited<ReturnType<typeof startSubagentToolRun>>;
}> {
  const run = await startSubagentToolRun({
    action: input.action,
    ownerToken: input.ownerToken,
    session: createSubagentToolRunSession({
      auth: { current: input.auth, initiator: input.initiatorAuth },
      id: input.session.sessionId,
      parent: input.parentSession,
      sequence: input.batchEvent.sequence,
      turnId: input.batchEvent.turnId,
    }),
    stepIndex: input.stepIndex,
  });
  if (!run.replyReady) return { run };
  const outcome = await startSubagent({
    ...input,
    parentContinuationToken: run.replyToken,
    taskOwned: false,
  });
  return { outcome, run };
}
