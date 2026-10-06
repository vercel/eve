/**
 * A connection tool as a catalog entry: the definition an `execute` call to
 * `<connection>__<tool>` runs. It calls the connection's client, applies the
 * connection's approval under the entry's name, and runs an approved call only
 * against the connection instance it was approved for.
 */

import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import {
  resolveApprovalPolicy,
  type Approval,
  type ApprovalContext,
  type ApprovalPolicy,
  type ApprovalResponseContext,
  type ApprovalResponseDecision,
  type ApprovalResponsePolicy,
  type ApprovalStatus,
} from "#approval/definition.js";
import { isConnectionAuthorizationRequiredError } from "#connections/errors.js";
import { connectionToolName } from "#connections/ownership.js";
import { loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { isApprovalRecheck } from "#harness/approval-recheck.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import { createAuthorizationExecution } from "#runtime/connections/scoped-authorization.js";
import {
  connectionToolModelOutput,
  toConnectionToolResult,
} from "#runtime/connections/tool-result.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import type { ConnectionToolMetadata } from "#shared/connection-types.js";
import { displayProperName, displayTitle } from "#shared/display-name.js";
import { isObject } from "#shared/guards.js";
import type { JsonObject } from "#shared/json.js";
import type { ToolExecuteOptions } from "#tools/definition.js";
import { defineJsonSchema, refineJsonSchema } from "#tools/schema.js";

import {
  assertPendingAuthorizationInstances,
  listingFailureMessage,
  resolveInteractiveAuthorization,
} from "./connection-auth.js";
import { closestNames } from "./rank.js";
import { connectionToolSignature } from "./signatures.js";

const MAX_SUGGESTIONS = 5;

/** Bounds approval pins; an evicted pin rejects its call rather than letting it run. */
const MAX_APPROVAL_PINS = 50;

const CONNECTION_CHANGED_MESSAGE =
  "The connection for this tool call changed or is unavailable. Request a new tool call and approval.";

/**
 * Connection instance each parked call was sent for approval against, keyed by
 * call id. When a person approves the call, it runs only if its connection
 * still resolves to that instance; a changed instance or a missing pin (the map
 * is bounded) rejects it.
 */
const ConnectionApprovalPinsKey = new ContextKey<Readonly<Record<string, string>>>(
  "eve.connectionApprovalPins",
);

/** The pin for a connection's instance; one without an id still gets a pin. */
function instanceKey(connection: ResolvedConnectionDefinition): string {
  return connection.instanceId ?? "";
}

/** No instance id matches this, so the call fails when it runs. */
const CHANGED_INSTANCE = "\u0000changed";

/** The entry for one tool of one connection instance. */
export function connectionEntry(
  connection: ResolvedConnectionDefinition,
  toolName: string,
): HarnessToolDefinition {
  const label = `${displayProperName(connection.connectionName)}: ${displayTitle(toolName)}`;
  return {
    approval: connectionApproval(connection),
    deferred: true,
    description: "",
    execute: (input: unknown, options: ToolExecuteOptions) =>
      callConnectionTool(connection, toolName, input, options),
    // Checked before approval, so no one is asked to approve a call that cannot run.
    inputSchema: refineJsonSchema({}, (input) => checkInput(connection, toolName, input)),
    label: { start: () => label },
    name: connectionToolName(connection.connectionName, toolName),
    toModelOutput: connectionToolModelOutput,
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function callConnectionTool(
  connection: ResolvedConnectionDefinition,
  toolName: string,
  rawInput: unknown,
  options: ToolExecuteOptions,
): Promise<unknown> {
  const registry = requireRegistry();
  releaseApprovalPin(options.toolCallId, connection);
  assertPendingAuthorizationInstances(registry, [connection]);

  const scoped = await resolveInteractiveAuthorization(registry, connection.connectionName);
  const auth = createAuthorizationExecution();
  if (scoped !== undefined) await auth.complete(scoped);
  const client = registry.getClient(connection.connectionName);
  // A client that connected anonymously before sign-in must reconnect with the new token.
  if (scoped !== undefined && auth.isJustAuthorized(scoped)) await client.close();

  let tools: readonly ConnectionToolMetadata[];
  try {
    tools = await client.getToolMetadata();
  } catch (error) {
    return await auth.handleError(error, scoped);
  }
  // Validation may have run before a sign-in made the tools listable.
  const checked = await checkCall(connection, tools, toolName, rawInput);
  if ("error" in checked) throw new Error(checked.error);
  const { input, tool } = checked;

  let raw: unknown;
  try {
    raw = await client.executeTool(tool.name, input, {
      abortSignal: options.abortSignal,
      callId: options.toolCallId,
    });
  } catch (error) {
    if (isConnectionAuthorizationRequiredError(error)) return await auth.handleError(error, scoped);
    throw error;
  }

  const result = toConnectionToolResult(connection.protocol, tool, raw);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

async function checkInput(
  connection: ResolvedConnectionDefinition,
  toolName: string,
  input: unknown,
): Promise<StandardSchemaV1.Result<unknown>> {
  let tools: readonly ConnectionToolMetadata[];
  try {
    tools = await requireRegistry().getClient(connection.connectionName).getToolMetadata();
  } catch (error) {
    // Only the call itself can start the sign-in that makes its tools listable.
    if (isConnectionAuthorizationRequiredError(error)) return { value: input };
    return { issues: [{ message: listingFailureMessage(connection.connectionName, error) }] };
  }
  const checked = await checkCall(connection, tools, toolName, input);
  return "error" in checked ? { issues: [{ message: checked.error }] } : { value: checked.input };
}

type CallCheck =
  | { readonly input: JsonObject; readonly tool: ConnectionToolMetadata }
  | { readonly error: string };

/** The tool a call runs and its input with schema defaults filled in, or why it cannot run. */
async function checkCall(
  connection: ResolvedConnectionDefinition,
  tools: readonly ConnectionToolMetadata[],
  toolName: string,
  input: unknown,
): Promise<CallCheck> {
  const tool = tools.find((entry) => entry.name === toolName);
  if (tool === undefined) return { error: unknownToolMessage(connection, toolName, tools) };
  const result = await defineJsonSchema(tool.inputSchema as JsonObject)["~standard"].validate(
    isObject(input) ? input : {},
  );
  if (result.issues === undefined) return { input: result.value as JsonObject, tool };
  const issues = result.issues
    .map((issue) => {
      const path = (issue.path ?? [])
        .map((segment) => (typeof segment === "object" ? String(segment.key) : String(segment)))
        .join(".");
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
  const name = connectionToolName(connection.connectionName, tool.name);
  return {
    error: `Invalid input for "${name}": ${issues}. Signature: ${connectionToolSignature(connection, tool)}`,
  };
}

function unknownToolMessage(
  connection: ResolvedConnectionDefinition,
  toolName: string,
  tools: readonly ConnectionToolMetadata[],
): string {
  const { connectionName } = connection;
  const suggestions = closestNames(toolName, tools, MAX_SUGGESTIONS).map((name) =>
    connectionToolName(connectionName, name),
  );
  const hint =
    suggestions.length > 0
      ? ` Closest tools: ${suggestions.join(", ")}.`
      : ` Find its tools with search({ connection: "${connectionName}" }).`;
  return `Connection "${connectionName}" has no tool named "${toolName}".${hint}`;
}

function requireRegistry(): ConnectionRegistry {
  const registry = loadContext().get(ConnectionRegistryKey);
  if (registry === undefined) throw new Error("This agent has no connections.");
  return registry;
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

/**
 * The connection's approval, pinned to this connection instance. The response
 * phase exists only when the connection defines one; without it, the pin is
 * checked when the approved call runs.
 */
function connectionApproval(connection: ResolvedConnectionDefinition): Approval | undefined {
  const { approval } = connection;
  if (approval === undefined) return undefined;
  const policy = resolveApprovalPolicy(approval);
  const request = (context: ApprovalContext) => requestApproval(connection, policy, context);
  const response = typeof approval === "function" ? undefined : approval.response;
  if (response === undefined) return request;
  return {
    request,
    response: (context: ApprovalResponseContext) =>
      authorizeApprovalResponse(connection, response, context),
  };
}

async function requestApproval(
  connection: ResolvedConnectionDefinition,
  policy: ApprovalPolicy,
  context: ApprovalContext,
): Promise<ApprovalStatus> {
  // Denying here would drop the call without a result, so the approved call
  // runs and fails in execution instead, where the failure is reported.
  if (isApprovalRecheck(context) && !matchesApprovalPin(context.callId, connection)) {
    markApprovalPinChanged(context.callId);
  }
  const status = await policy(context);
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

async function authorizeApprovalResponse(
  connection: ResolvedConnectionDefinition,
  response: ApprovalResponsePolicy,
  context: ApprovalResponseContext,
): Promise<ApprovalResponseDecision> {
  if (!matchesApprovalPin(context.request.callId, connection)) {
    return { reason: CONNECTION_CHANGED_MESSAGE, status: "rejected" };
  }
  return await response(context);
}

/** Records the instance a parked call was first sent for approval against. */
function pinApprovedInstance(callId: string, connection: ResolvedConnectionDefinition): void {
  const ctx = loadContext();
  if (ctx.get(ConnectionApprovalPinsKey)?.[callId] !== undefined) return;
  ctx.set(ConnectionApprovalPinsKey, (pins = {}) =>
    Object.fromEntries([
      ...Object.entries(pins).slice(-(MAX_APPROVAL_PINS - 1)),
      [callId, instanceKey(connection)],
    ]),
  );
}

/** Fails closed: a parked call whose pin is missing counts as changed. */
function matchesApprovalPin(callId: string, connection: ResolvedConnectionDefinition): boolean {
  const pinned = loadContext().get(ConnectionApprovalPinsKey)?.[callId];
  return pinned !== undefined && pinned === instanceKey(connection);
}

function markApprovalPinChanged(callId: string): void {
  loadContext().set(ConnectionApprovalPinsKey, (pins = {}) => ({
    ...pins,
    [callId]: CHANGED_INSTANCE,
  }));
}

/** Consumes the call's approval pin, rejecting the call if its connection changed. */
function releaseApprovalPin(callId: string, connection: ResolvedConnectionDefinition): void {
  const ctx = loadContext();
  const pins = ctx.get(ConnectionApprovalPinsKey);
  if (pins?.[callId] === undefined) return;
  const { [callId]: pinned, ...rest } = pins;
  ctx.set(ConnectionApprovalPinsKey, rest);
  if (pinned !== instanceKey(connection)) {
    throw new Error(CONNECTION_CHANGED_MESSAGE);
  }
}
