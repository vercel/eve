/**
 * Approval for `connection_execute`: each call is approved under the called
 * connection's own policy, keyed by connection and tool, and an approved call
 * runs only against the connection instance it was approved for.
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
import { ContextKey } from "#context/key.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { isApprovalRecheck } from "#harness/approval-recheck.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import { defineDurableCallback } from "#tools/durable-callbacks.js";

import {
  CONNECTION_EXECUTE_TOOL_NAME,
  findConnection,
  qualifiedToolName,
  readExecuteTarget,
  type ExecuteTarget,
} from "./connection-target.js";

/** Bounds approval pins; an evicted pin rejects its call rather than letting it run. */
const MAX_APPROVAL_PINS = 50;

/**
 * Connection instance each parked `connection_execute` call was sent for
 * approval against, keyed by call id. When a person approves the call, it runs
 * only if its connection still resolves to that instance; a changed instance or
 * a missing pin (the map is bounded) rejects it.
 */
const ConnectionApprovalPinsKey = new ContextKey<Readonly<Record<string, string>>>(
  "eve.connectionApprovalPins",
);

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

  // Denying here would drop the call without a result, so the approved call
  // runs and fails in execution instead, where the failure is reported.
  if (isApprovalRecheck(context) && !matchesApprovalPin(context.callId, connection)) {
    markApprovalPinChanged(context.callId);
  }
  const status = await resolveApprovalPolicy(approval)({
    ...context,
    approvedTools: policyApprovedTools(context.approvedTools, target),
    toolInput: target.input,
    toolName: qualifiedToolName(target),
  });
  if (!isApprovalRecheck(context) && parksForApproval(status)) {
    pinApprovedInstance(context.callId, connection);
  }
  return status;
}

function parksForApproval(status: ApprovalStatus): boolean {
  return (
    status === true ||
    status === "user-approval" ||
    (typeof status === "object" && status.type === "user-approval")
  );
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
  if (!matchesApprovalPin(context.request.callId, connection)) {
    return { reason: CONNECTION_CHANGED_MESSAGE, status: "rejected" };
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

const CONNECTION_CHANGED_MESSAGE =
  "The connection for this tool call changed or is unavailable. Request a new tool call and approval.";

/** Stands in for connections without an instance id, so every parked call has a pin. */
const UNKEYED_INSTANCE = "";

/** Records the instance a parked call was first sent for approval against. */
function pinApprovedInstance(callId: string, connection: ResolvedConnectionDefinition): void {
  const instanceId = connection.instanceId ?? UNKEYED_INSTANCE;
  const ctx = loadContext();
  if (ctx.get(ConnectionApprovalPinsKey)?.[callId] !== undefined) return;
  ctx.set(ConnectionApprovalPinsKey, (pins = {}) =>
    Object.fromEntries([
      ...Object.entries(pins).slice(-(MAX_APPROVAL_PINS - 1)),
      [callId, instanceId],
    ]),
  );
}

/** Fails closed: a parked call whose pin is missing counts as changed. */
function matchesApprovalPin(callId: string, connection: ResolvedConnectionDefinition): boolean {
  const pinned = loadContext().get(ConnectionApprovalPinsKey)?.[callId];
  return pinned !== undefined && pinned === (connection.instanceId ?? UNKEYED_INSTANCE);
}

/** No instance id matches this, so the call fails when it runs. */
const CHANGED_INSTANCE = "\u0000changed";

function markApprovalPinChanged(callId: string): void {
  loadContext().set(ConnectionApprovalPinsKey, (pins = {}) => ({
    ...pins,
    [callId]: CHANGED_INSTANCE,
  }));
}

/** Consumes the call's approval pin, rejecting the call if its connection changed. */
export function releaseApprovalPin(callId: string, connection: ResolvedConnectionDefinition): void {
  const ctx = loadContext();
  const pins = ctx.get(ConnectionApprovalPinsKey);
  if (pins?.[callId] === undefined) return;
  const { [callId]: pinned, ...rest } = pins;
  ctx.set(ConnectionApprovalPinsKey, rest);
  if (pinned !== (connection.instanceId ?? UNKEYED_INSTANCE)) {
    throw new Error(CONNECTION_CHANGED_MESSAGE);
  }
}
