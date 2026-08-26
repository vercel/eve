import { type AlsContext, loadContext } from "#context/container.js";
import { HandleEventKey } from "#context/keys.js";
import { serializeContext } from "#context/serialize.js";
import {
  createTaskAgentContinuationMismatch,
  dispatchToTaskAgentAddress,
  type DispatchOutcome,
  type RuntimeSession,
} from "#execution/agent-handle-dispatch.js";
import { createAgentContinuationBundle } from "#execution/agent-continuation-bundle.js";
import {
  prepareAgentActionDispatch,
  startSubagent,
} from "#execution/dispatch-runtime-actions-shared.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import {
  checkTaskContinuationAvailability,
  createTaskContinuationBusyResult,
  describeTaskDispatch,
} from "#execution/tasks/parent/continuation-dispatch.js";
import { findTaskAgentAddress } from "#execution/tasks/parent/control-shared.js";
import type { BackgroundTask } from "#execution/tasks/parent/delegate.js";
import { CallbackBaseUrlKey } from "#harness/authorization.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import { defineTool, type TaskExec, type ToolContext } from "#tools/definition.js";
import { readTaskExecLocalFanout } from "#tools/task.js";
import type {
  RuntimeRemoteAgentCallActionRequest,
  RuntimeSubagentCallActionRequest,
} from "#shared/action-types.js";
import { SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA } from "#tools/framework/task-contract.js";
import { SUBAGENT_TOOL_INPUT_SCHEMA } from "#tools/framework/agent-contract.js";
import { parseJsonObject } from "#shared/json.js";
import { createSubagentExecutorBinding } from "#tasks/types.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { createSubagentCalledEvent } from "#protocol/message.js";
import { workflowEntryReference } from "#execution/workflow-runtime.js";
import { createLogger, logError } from "#internal/logging.js";

type SubagentCallAction = RuntimeRemoteAgentCallActionRequest | RuntimeSubagentCallActionRequest;

interface SubagentDefinitionInput {
  readonly description: string;
  readonly name: string;
  readonly nodeId: string;
}

interface SubagentDispatchInput {
  readonly action: SubagentCallAction;
  readonly batch: TaskExec["batch"];
  readonly callbackBaseUrl?: string;
  readonly ctx: AlsContext;
  readonly event: {
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
  readonly localFanoutSize: number;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: ReturnType<typeof createDurableSessionState>;
  readonly task: BackgroundTask;
}

interface SubagentDispatchResult {
  readonly address: Extract<DispatchOutcome, { readonly kind: "called" }>["address"];
  readonly agentId: string;
  readonly mode: "local" | "remote";
  readonly name: string;
  readonly remote?: { readonly resolverId: string; readonly url: string };
  readonly session: RuntimeSession;
}

/** Transitional PR 1 classifier, replaced by declared dispatch effects in PR 2. */
const localSubagentExecutors = new WeakSet<object>();
const batchAgentClaims = new WeakMap<TaskExec["batch"], Map<string, string>>();
const log = createLogger("runtime.framework-tools.subagent");

export function defineSubagent(input: SubagentDefinitionInput) {
  const definition = defineTool({
    description: input.description,
    execution: "background",
    inputSchema: SUBAGENT_TOOL_INPUT_SCHEMA,
    outputSchema: SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA,
    execute: (toolInput, ctx, task) =>
      executeSubagentTool({ definition: input, kind: "local", task, toolContext: ctx, toolInput }),
  });
  return definition;
}

export function registerLocalSubagentExecutor(execute: object): void {
  localSubagentExecutors.add(execute);
}

export function isLocalSubagentCall(call: {
  readonly definition: { readonly execute: object };
}): boolean {
  return localSubagentExecutors.has(call.definition.execute);
}

export function countLocalSubagentCalls(
  calls: readonly { readonly definition: { readonly execute: object } }[],
): number {
  return calls.filter(isLocalSubagentCall).length;
}

export async function executeSubagentTool(input: {
  readonly definition: SubagentDefinitionInput;
  readonly kind: "local" | "remote";
  readonly task: TaskExec;
  readonly toolContext: ToolContext;
  readonly toolInput: unknown;
}) {
  const ctx = loadContext();
  const { batch, session, task } = input.task;
  const emission = getHarnessEmissionState(session.state);
  const commonAction = {
    callId: input.toolContext.callId,
    description: input.definition.description,
    input: parseJsonObject(SUBAGENT_TOOL_INPUT_SCHEMA.parse(input.toolInput)),
    name: input.definition.name,
    nodeId: input.definition.nodeId,
  };
  const action: SubagentCallAction =
    input.kind === "remote"
      ? {
          ...commonAction,
          kind: "remote-agent-call",
          remoteAgentName: input.definition.name,
        }
      : {
          ...commonAction,
          kind: "subagent-call",
          subagentName: input.definition.name,
        };
  const dispatched = await dispatchSubagent({
    action,
    batch,
    callbackBaseUrl: ctx.get(CallbackBaseUrlKey),
    ctx,
    event: { ...emission, turnId: activeTurnId(emission) },
    localFanoutSize: readTaskExecLocalFanout(input.task) ?? countLocalSubagentCalls(batch),
    serializedContext: serializeContext(ctx),
    sessionState: createDurableSessionState({ session }),
    task,
  });
  // The executor binding is the durable copy of the child's addressed
  // handle, read back from the post-dispatch session so it is exactly what
  // the handle store recorded (fresh start) or already held (resume). It is
  // deep-equal on replay — identity and address derive from the originating
  // call — and it is the only channel the task layer needs: commit writes
  // the address into the parent handle store, and compensation or a later
  // turn cancels the child through it.
  const record = findTaskAgentAddress(dispatched.session, dispatched.agentId);
  if (record === undefined) {
    throw new Error(
      `Subagent dispatch for "${dispatched.agentId}" recorded no task agent address.`,
    );
  }
  const executor = createSubagentExecutorBinding({
    address: record.address,
    identity: record.identity,
  });
  await emitSubagentCalled({
    callId: input.toolContext.callId,
    childSessionId: dispatched.address.sessionId,
    event: { ...emission, turnId: activeTurnId(emission) },
    name: dispatched.name,
    remote: dispatched.remote,
    sessionId: session.sessionId,
    toolName: input.definition.name,
  });

  const delegated = input.task.delegated({
    executor,
    receipt: { agentId: dispatched.agentId },
  });
  await emitSubagentCompleted({
    callId: input.toolContext.callId,
    output: JSON.stringify(delegated.receipt),
    subagentName: dispatched.name,
    taskId: delegated.receipt.taskId,
  });
  return delegated;
}

async function dispatchSubagent(input: SubagentDispatchInput): Promise<SubagentDispatchResult> {
  const prepared = await prepareAgentActionDispatch({
    action: input.action,
    ctx: input.ctx,
    event: input.event,
    localFanoutSize: input.localFanoutSize,
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
  });
  const entry = prepared.plan[0];
  if (entry === undefined || entry.kind === "task-control") {
    throw new Error("Subagent tool dispatch produced no executable plan entry.");
  }
  if (entry.kind === "reject") {
    throw new Error(JSON.stringify(entry.result.output));
  }

  if (entry.kind === "resume") {
    const mismatch = createTaskAgentContinuationMismatch({
      action: entry.action,
      agentId: entry.agentId,
      currentSession: prepared.session,
    });
    if (mismatch !== undefined) throw new Error(JSON.stringify(mismatch.output));

    const busy = await checkTaskContinuationAvailability({
      action: entry.action,
      agentId: entry.agentId,
      parentStepIndex: input.event.stepIndex,
      parentTurnId: input.event.turnId,
      session: prepared.session,
    });
    if (busy !== undefined) throw new Error(JSON.stringify(busy.output));

    const claimedTaskId = claimBatchAgent(input.batch, entry.agentId, input.task.taskId);
    if (claimedTaskId !== undefined) {
      const busy = createTaskContinuationBusyResult({
        action: entry.action,
        agentId: entry.agentId,
        status: "working",
        taskId: claimedTaskId,
      });
      throw new Error(JSON.stringify(busy.output));
    }
  }

  const outcome =
    entry.kind === "resume"
      ? await dispatchToTaskAgentAddress({
          action: entry.action,
          agentId: entry.agentId,
          auth: prepared.auth,
          bundle: createAgentContinuationBundle({
            action: entry.action,
            bundle: prepared.bundle,
            dynamicRemoteAgent: entry.dynamicRemoteAgent,
          }),
          currentSession: prepared.session,
          parentToken: input.task.taskInboxToken,
        })
      : await startSubagent({
          auth: prepared.auth,
          batchEvent: input.event,
          bundle: prepared.bundle,
          callbackBaseUrl: input.callbackBaseUrl,
          capabilities: prepared.capabilities,
          channelMetadata: prepared.channelMetadata,
          currentSession: prepared.session,
          fanoutSize: prepared.fanoutSize,
          initiatorAuth: prepared.initiatorAuth,
          parentContinuationToken: input.task.taskInboxToken,
          parentTraceContext: prepared.parentTraceContext,
          sandboxSessionId: prepared.sandboxSessionId,
          serializedContext: prepared.serializedContext,
          session: prepared.session,
          taskOwned: true,
          target: entry.target,
        });
  if (outcome.kind === "error") throw new Error(JSON.stringify(outcome.result.output));

  const described = describeTaskDispatch({
    action: input.action,
    agentId: entry.kind === "resume" ? entry.agentId : undefined,
    parentSessionId: prepared.session.sessionId,
    parentTurnId: input.event.turnId,
    session: outcome.session,
  });
  const dynamicRemoteAgent =
    entry.kind === "resume"
      ? entry.dynamicRemoteAgent
      : entry.target.kind === "remote"
        ? entry.target.dynamicRemoteAgent
        : undefined;
  return {
    address: outcome.address,
    agentId: described.agentId,
    mode: described.mode,
    name: described.name,
    ...(outcome.address.kind === "agent/remote"
      ? {
          remote: {
            resolverId: dynamicRemoteAgent?.credentialsStepId ?? input.action.nodeId,
            url: outcome.address.url,
          },
        }
      : {}),
    session: outcome.session,
  };
}

function claimBatchAgent(
  batch: TaskExec["batch"],
  agentId: string,
  taskId: string,
): string | undefined {
  let claims = batchAgentClaims.get(batch);
  if (claims === undefined) {
    claims = new Map();
    batchAgentClaims.set(batch, claims);
  }
  const claimedTaskId = claims.get(agentId);
  if (claimedTaskId !== undefined) return claimedTaskId;
  claims.set(agentId, taskId);
  return undefined;
}

async function emitSubagentCalled(input: {
  readonly callId: string;
  readonly childSessionId: string;
  readonly event: { readonly sequence: number; readonly turnId: string };
  readonly name: string;
  readonly remote?: { readonly resolverId: string; readonly url: string };
  readonly sessionId: string;
  readonly toolName: string;
}): Promise<void> {
  const handleEvent = loadContext().get(HandleEventKey);
  if (handleEvent === undefined) return;
  try {
    await handleEvent(
      createSubagentCalledEvent({
        callId: input.callId,
        childSessionId: input.childSessionId,
        name: input.name,
        remote: input.remote,
        sequence: input.event.sequence,
        sessionId: input.sessionId,
        toolName: input.toolName,
        turnId: input.event.turnId,
        workflowId: workflowEntryReference.workflowId,
      }),
    );
  } catch (error) {
    logError(log, "subagent.called emission failed", error, {
      callId: input.callId,
      childSessionId: input.childSessionId,
      toolName: input.toolName,
    });
  }
}

async function emitSubagentCompleted(input: {
  readonly callId: string;
  readonly output: string;
  readonly subagentName: string;
  readonly taskId: string;
}): Promise<void> {
  const handleEvent = loadContext().get(HandleEventKey);
  if (handleEvent === undefined) return;
  try {
    await handleEvent({
      data: {
        backgroundTask: { status: "working", taskId: input.taskId },
        callId: input.callId,
        output: input.output,
        subagentName: input.subagentName,
      },
      type: "subagent.completed",
    });
  } catch (error) {
    logError(log, "subagent.completed emission failed", error, {
      callId: input.callId,
      taskId: input.taskId,
    });
  }
}
