/**
 * Approval for `connection_execute`: each call is approved under the called
 * connection's own policy, keyed by connection and tool.
 */

import {
  resolveApprovalPolicy,
  type Approval,
  type ApprovalContext,
  type ApprovalResponseContext,
  type ApprovalResponseDecision,
  type ApprovalStatus,
} from "#approval/definition.js";
import { loadContext } from "#context/container.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { defineDurableCallback } from "#tools/durable-callbacks.js";

import {
  CONNECTION_EXECUTE_TOOL_NAME,
  findConnection,
  qualifiedToolName,
  readExecuteTarget,
  type ExecuteTarget,
} from "./connection-target.js";

/**
 * Delegates approval to the called connection's policy. The request and
 * response phases exist only when some registered connection defines them,
 * so connections without a response policy keep the default response flow
 * unless another connection in the same agent defines one.
 */
export function connectionExecuteApproval(approvals: readonly Approval[]) {
  if (approvals.length === 0) return {};
  const request = defineDurableCallback({ callback: requestConnectionApproval, closure: {} });
  const hasResponsePolicy = approvals.some(
    (approval) => typeof approval !== "function" && approval.response !== undefined,
  );
  return {
    approvalKey: defineDurableCallback({ callback: connectionApprovalKey, closure: {} }),
    approval: hasResponsePolicy
      ? {
          request,
          response: defineDurableCallback({
            callback: authorizeConnectionApprovalResponse,
            closure: {},
          }),
        }
      : request,
  };
}

/**
 * The recorded approval identity. `<connection>__<tool>` is not unique (a
 * connection `a` with tool `b__c` and a connection `a__b` with tool `c` share
 * it), so approvals are keyed on the pair.
 */
function connectionApprovalKey(_closure: object, input: unknown): string {
  const target = readExecuteTarget(input);
  return target === undefined ? CONNECTION_EXECUTE_TOOL_NAME : approvalKeyFor(target);
}

function approvalKeyFor(target: Pick<ExecuteTarget, "connection" | "tool">): string {
  return JSON.stringify([target.connection, target.tool]);
}

/**
 * Policies see the qualified tool name, so `approvedTools` lists it only when
 * this exact connection and tool were approved, never a same-named pair.
 */
function policyApprovedTools(
  approvedTools: ReadonlySet<string>,
  target: Pick<ExecuteTarget, "connection" | "tool">,
): ReadonlySet<string> {
  const qualified = qualifiedToolName(target);
  const view = new Set([...approvedTools].filter((key) => key !== qualified));
  if (approvedTools.has(approvalKeyFor(target))) view.add(qualified);
  return view;
}

async function requestConnectionApproval(
  _closure: object,
  context: ApprovalContext,
): Promise<ApprovalStatus> {
  const target = readExecuteTarget(context.toolInput);
  const registry = loadContext().get(ConnectionRegistryKey);
  if (target === undefined || registry === undefined) return "not-applicable";
  const connection = findConnection(registry, target.connection);
  const approval =
    connection === undefined
      ? undefined
      : registry.getConnectionApproval(connection.connectionName);
  if (connection === undefined || approval === undefined) return "not-applicable";

  return await resolveApprovalPolicy(approval)({
    ...context,
    approvedTools: policyApprovedTools(context.approvedTools, target),
    toolInput: target.input,
    toolName: qualifiedToolName(target),
  });
}

async function authorizeConnectionApprovalResponse(
  _closure: object,
  context: ApprovalResponseContext,
): Promise<ApprovalResponseDecision> {
  const target = readExecuteTarget(context.request.toolInput);
  const registry = loadContext().get(ConnectionRegistryKey);
  const connection =
    target === undefined || registry === undefined
      ? undefined
      : findConnection(registry, target.connection);
  if (target === undefined || registry === undefined || connection === undefined) {
    return { reason: "The connection for this tool call is unavailable.", status: "rejected" };
  }
  const approval = registry.getConnectionApproval(connection.connectionName);
  const response =
    approval === undefined || typeof approval === "function" ? undefined : approval.response;
  if (response === undefined) return { status: "allowed" };
  return await response({
    ...context,
    request: {
      ...context.request,
      toolInput: target.input,
      toolName: qualifiedToolName(target),
    },
  });
}
