import type { RuntimeActionResultHookPayload, SessionAuthContext } from "#channel/types.js";
import type { ContextContainer } from "#context/container.js";
import { getDynamicSubagentSelection } from "#context/dynamic-subagent-lifecycle.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type {
  RuntimeAgentDispatchRequest,
  RuntimeSubagentChildResult,
  RuntimeToolResultActionResult,
} from "#shared/action-types.js";
import type { JsonValue } from "#shared/json.js";
import {
  clearProxyInputRequestsForChild,
  remoteChildRouteToken,
} from "#harness/proxy-input-requests.js";
import type { SessionStateMap } from "#harness/types.js";
import { AGENT_OTHER_PRINCIPAL } from "#subagents/agent-handle-errors.js";
import type { AgentTaskCall, WorkflowCallerReply } from "#tasks/owner.js";
import type { TaskRecord } from "#tasks/record.js";
import { renderAgentOtherPrincipal } from "#tasks/render.js";
import { readTaskCreator, sameTaskPrincipal } from "#tasks/results.js";
import { isTerminalTaskStatus } from "#tasks/protocol.js";
import { findTask, removeTasks, type TaskTable } from "#tasks/table.js";

// How the owner resolves one agent call and the child report that settles it.

/**
 * Idle agents a session keeps. Each is a child session the model may give
 * more work. Each time the owner starts agents, it retires the idle agents
 * past this many, least recently started first, so a long session's records
 * and child sessions stay bounded. The `[Tasks]` note lists only the 10 most
 * recent.
 */
export const MAX_RETAINED_IDLE_AGENTS = 50;

/**
 * Removes idle agents past {@link MAX_RETAINED_IDLE_AGENTS}, least recently
 * started first. The calling principal's own idle agents go before anyone
 * else's, so in a shared session one caller's new agents end another
 * caller's agents only once the first has none idle. The owner ends each
 * retired agent's session; a later call with its ID fails `UNKNOWN_AGENT`.
 */
export function retireIdleAgents(
  table: TaskTable,
  caller: SessionAuthContext | null,
): {
  readonly table: TaskTable;
  readonly retired: readonly TaskRecord[];
} {
  const idle = table.records.filter(
    (record) =>
      record.kind === "agent" &&
      record.child !== undefined &&
      record.delivered &&
      record.cancelConfirmBy === undefined &&
      isTerminalTaskStatus(record.status),
  );
  const excess = idle.length - MAX_RETAINED_IDLE_AGENTS;
  if (excess <= 0) return { retired: [], table };
  const others = (record: TaskRecord) =>
    sameTaskPrincipal(readTaskCreator(record.creator).auth, caller) ? 0 : 1;
  const retired = idle
    .toSorted(
      (left, right) =>
        others(left) - others(right) || Date.parse(left.startedAt) - Date.parse(right.startedAt),
    )
    .slice(0, excess);
  return {
    retired,
    table: removeTasks(table, new Set(retired.map((record) => record.id))),
  };
}

/**
 * Rejects a call that names an agent a different principal started: another
 * user, a schedule, or an app. The agent acts with its starter's credentials
 * and keeps their conversation, so neither new work nor a steering message
 * from anyone else may reach it. Every unauthenticated caller is the same
 * anonymous principal, so this separates no two of them. Cancelling is not
 * checked: any caller with access to the session may stop any of its tasks.
 */
export function rejectOtherPrincipal(input: {
  readonly agentId: string | undefined;
  readonly caller: SessionAuthContext | null;
  readonly table: TaskTable;
}): JsonValue | undefined {
  if (input.agentId === undefined) return undefined;
  const agent = findTask(input.table, input.agentId);
  if (agent?.kind !== "agent") return undefined;
  if (sameTaskPrincipal(readTaskCreator(agent.creator).auth, input.caller)) return undefined;
  return { code: AGENT_OTHER_PRINCIPAL, message: renderAgentOtherPrincipal(agent.id) };
}

/**
 * Retires the input requests a child surfaced that it can no longer take: a
 * local child's once its session ended, a remote child's once it reported.
 */
export function clearReportedChildRoutes<T extends { readonly state?: SessionStateMap }>(
  session: T,
  record: TaskRecord,
  childEnded: boolean,
): T {
  const child = record.child;
  if (child?.kind === "remote") {
    return clearProxyInputRequestsForChild(session, remoteChildRouteToken(child.sessionId));
  }
  if (child?.kind === "local" && childEnded) {
    return clearProxyInputRequestsForChild(session, child.continuationToken);
  }
  return session;
}

export function readDynamicRemoteAgent(input: {
  readonly action: RuntimeAgentDispatchRequest;
  readonly bundle: CompiledBundle;
  readonly ctx: ContextContainer;
}) {
  if (input.action.kind !== "remote-agent-call") return undefined;
  if (input.bundle.subagentRegistry.dynamicNodeIds?.has(input.action.nodeId) !== true)
    return undefined;
  const selection = getDynamicSubagentSelection(input.ctx, input.action.nodeId);
  return selection?.kind === "remote" ? selection.remoteAgent : undefined;
}

export function readAgentId(action: RuntimeAgentDispatchRequest): string | undefined {
  const value = action.input.agentId;
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * The task a child's result settles: the current generation's call, from a
 * child of the matching kind. A cancelled task still accepts its child's
 * confirmation. Remote results must come from the remote session the owner
 * started, so one remote child cannot settle another task.
 */
export function findReportedTask(
  table: TaskTable,
  result: RuntimeSubagentChildResult,
  source: RuntimeActionResultHookPayload["source"],
): TaskRecord | undefined {
  return table.records.find((record) => {
    if (record.callId !== result.callId || record.name !== result.subagentName) return false;
    if (
      record.status !== "working" &&
      record.status !== "input_required" &&
      record.cancelConfirmBy === undefined
    ) {
      return false;
    }
    if (source?.kind === "remote") {
      return record.child?.kind === "remote" && source.sessionId === record.child.sessionId;
    }
    return record.child?.kind !== "remote";
  });
}

export function resolveFailedCall(input: {
  readonly action: RuntimeAgentDispatchRequest | undefined;
  readonly call: AgentTaskCall;
  readonly output: JsonValue;
  readonly replies: WorkflowCallerReply[];
  readonly results: RuntimeToolResultActionResult[];
}): void {
  const { call } = input;
  if (call.workflowCaller !== undefined) {
    input.replies.push({
      replyTo: call.workflowCaller.replyTo,
      result: {
        callId: call.callId,
        isError: true,
        kind: "subagent-result",
        origin: "dispatch",
        output: input.output,
        subagentName: call.input.target,
      },
    });
    return;
  }
  input.results.push({
    callId: call.callId,
    isError: true,
    kind: "tool-result",
    output: input.output,
    toolName: call.toolName ?? call.input.target,
  });
}
