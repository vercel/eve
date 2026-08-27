import type { SessionAuth } from "#context/keys.js";
import { deriveRunOwner } from "#execution/tool-run/messages.js";
import { deriveToolRunHookToken, startToolRun } from "#execution/tool-run/start.js";
import type { ToolRunSessionContext } from "#execution/tool-run/types.js";
import {
  subagentToolExecuteWorkflowReference,
  waitForCommandHookOwner,
} from "#execution/workflow-runtime.js";
import type {
  RuntimeRemoteAgentCallActionRequest,
  RuntimeSubagentDispatchFailure,
  RuntimeSubagentCallActionRequest,
} from "#shared/action-types.js";
import { resumeHook } from "#internal/workflow/runtime.js";

type SubagentAction = RuntimeRemoteAgentCallActionRequest | RuntimeSubagentCallActionRequest;

/** Starts the one durable execute run used by every subagent definition. */
export async function startSubagentToolRun(input: {
  readonly action: SubagentAction;
  readonly ownerToken: string;
  readonly session: ToolRunSessionContext;
  readonly stepIndex: number;
}): Promise<{
  readonly hookToken: string;
  readonly replyReady: boolean;
  readonly replyToken: string;
  readonly runId: string;
}> {
  const hookToken = deriveToolRunHookToken({
    callId: input.action.callId,
    parentSessionId: input.session.id,
    parentTurnId: input.session.turn.id,
  });
  const replyToken = `${input.ownerToken}:subagent:${hookToken.slice("eve:tool-run:".length)}`;
  const owner = deriveRunOwner(input.ownerToken);
  const started = await startToolRun({
    callId: input.action.callId,
    input: input.action.input,
    owner,
    session: input.session,
    stepIndex: input.stepIndex,
    subagent: {
      replyToken,
      subagentName:
        input.action.kind === "remote-agent-call"
          ? input.action.remoteAgentName
          : input.action.subagentName,
    },
    toolName: input.action.name,
    workflowId: subagentToolExecuteWorkflowReference.workflowId,
  });
  const replyReady = await waitForSubagentReplyHook({
    ownsRun: started.ownsRun,
    replyToken,
    runId: started.runId,
  });
  if (!replyReady) {
    return { hookToken: started.hookToken, replyReady: false, replyToken, runId: started.runId };
  }
  return { hookToken: started.hookToken, replyReady: true, replyToken, runId: started.runId };
}

export async function waitForSubagentReplyHook(input: {
  readonly ownsRun: boolean;
  readonly replyToken: string;
  readonly runId: string;
}): Promise<boolean> {
  if (!input.ownsRun) return true;
  try {
    const owner = await waitForCommandHookOwner(input.replyToken);
    return owner.runId === input.runId;
  } catch {
    return false;
  }
}

/** Routes a parent-synthesized admission failure through the shared execute run. */
export async function settleSubagentToolRunDispatchFailure(input: {
  readonly replyToken: string;
  readonly result: RuntimeSubagentDispatchFailure;
}): Promise<void> {
  await resumeHook(input.replyToken, {
    kind: "runtime-action-result",
    results: [input.result],
  });
}

export function createSubagentToolRunSession(input: {
  readonly auth: SessionAuth;
  readonly id: string;
  readonly parent: ToolRunSessionContext["parent"];
  readonly sequence: number;
  readonly turnId: string;
}): ToolRunSessionContext {
  return {
    auth: input.auth,
    id: input.id,
    parent: input.parent,
    turn: { id: input.turnId, sequence: input.sequence },
  };
}
