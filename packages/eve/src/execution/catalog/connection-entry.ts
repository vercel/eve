/**
 * A connection's catalog entries. `<connection>__<tool>` calls one of its
 * tools: it applies the connection's approval under the entry's name and runs
 * an approved call only against the connection instance it was approved for.
 * The connection's own name signs the user in, so its tools become listable.
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
import { isApprovalRecheck } from "#harness/approval-recheck.js";
import type { AuthorizationSignal } from "#harness/authorization.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
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
import { SEARCH_TOOL_NAME } from "#protocol/catalog-tools.js";

import {
  completeConnectionSignIn,
  listConnectionTools,
  listingFailureMessage,
} from "./connection-auth.js";
import { closestNames } from "./rank.js";
import { connectionToolSignature } from "./signatures.js";

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

/** The entry for one tool of one connection instance in `registry`. */
export function connectionEntry(
  registry: ConnectionRegistry,
  connection: ResolvedConnectionDefinition,
  toolName: string,
): HarnessToolDefinition {
  const label = `${displayProperName(connection.connectionName)}: ${displayTitle(toolName)}`;
  return {
    approval: connectionApproval(connection),
    deferred: true,
    description: "",
    execute: (input: unknown, options: ToolExecuteOptions) =>
      callConnectionTool(registry, connection, toolName, input, options),
    // Checked before approval, so no one is asked to approve a call that cannot run.
    inputSchema: refineJsonSchema({}, (input) => checkInput(registry, connection, toolName, input)),
    label: { start: () => label },
    name: connectionToolName(connection.connectionName, toolName),
    toModelOutput: connectionToolModelOutput,
  };
}

/**
 * The entry for a connection's own name: it signs the user in when listing the
 * connection's tools needs that, then points the model at `eve__search`.
 */
export function connectionSignInEntry(
  registry: ConnectionRegistry,
  connection: ResolvedConnectionDefinition,
): HarnessToolDefinition {
  const displayName = displayProperName(connection.connectionName);
  const signIn = `Sign in to use the ${displayName} tools`;
  return {
    deferred: true,
    description:
      connection.description === "" ? `${signIn}.` : `${signIn}: ${connection.description}`,
    execute: () => connect(registry, connection),
    inputSchema: defineJsonSchema({ type: "object", properties: {}, additionalProperties: false }),
    label: { start: () => `Sign in to ${displayName}` },
    name: connection.connectionName,
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function connect(
  registry: ConnectionRegistry,
  connection: ResolvedConnectionDefinition,
): Promise<string | AuthorizationSignal> {
  const session = await completeConnectionSignIn(registry, connection);
  const listing = await listConnectionTools(connection, session);
  if ("failure" in listing) throw new Error(listing.failure);
  if ("authorization" in listing) {
    return await session.auth.handleError(listing.error, listing.authorization);
  }
  const displayName = displayProperName(connection.connectionName);
  const search = `${SEARCH_TOOL_NAME}({ query: "${connection.connectionName}__" })`;
  // A listable connection may not need sign-in at all, so only a sign-in this call completed counts.
  return session.scoped !== undefined && session.auth.isJustAuthorized(session.scoped)
    ? `Signed in to ${displayName}. Find the ${displayName} tools with ${search}.`
    : `The ${displayName} tools are available. Find them with ${search}.`;
}

async function callConnectionTool(
  registry: ConnectionRegistry,
  connection: ResolvedConnectionDefinition,
  toolName: string,
  rawInput: unknown,
  options: ToolExecuteOptions,
): Promise<unknown> {
  releaseApprovalPin(options.toolCallId, connection);
  const session = await completeConnectionSignIn(registry, connection);
  const { auth, client, scoped } = session;
  const listing = await listConnectionTools(connection, session);
  if ("failure" in listing) throw new Error(listing.failure);
  if ("authorization" in listing) {
    return await auth.handleError(listing.error, listing.authorization);
  }
  // Validation may have run before a sign-in made the tools listable.
  const checked = await checkCall(connection, listing.tools, toolName, rawInput);
  if ("issues" in checked) throw new Error(issuesMessage(checked.issues));
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
  registry: ConnectionRegistry,
  connection: ResolvedConnectionDefinition,
  toolName: string,
  input: unknown,
): Promise<StandardSchemaV1.Result<unknown>> {
  let tools: readonly ConnectionToolMetadata[];
  try {
    tools = await registry.getClient(connection.connectionName).getToolMetadata();
  } catch (error) {
    // Only the call itself can start the sign-in that makes its tools listable.
    if (isConnectionAuthorizationRequiredError(error)) return { value: input };
    return { issues: [{ message: listingFailureMessage(connection.connectionName, error) }] };
  }
  const checked = await checkCall(connection, tools, toolName, input);
  return "issues" in checked ? { issues: checked.issues } : { value: checked.input };
}

type CallCheck =
  | { readonly input: JsonObject; readonly tool: ConnectionToolMetadata }
  | { readonly issues: readonly StandardSchemaV1.Issue[] };

/** The tool a call runs and its input with schema defaults filled in, or why it cannot run. */
async function checkCall(
  connection: ResolvedConnectionDefinition,
  tools: readonly ConnectionToolMetadata[],
  toolName: string,
  input: unknown,
): Promise<CallCheck> {
  const tool = tools.find((entry) => entry.name === toolName);
  if (tool === undefined) {
    return { issues: [{ message: unknownToolMessage(connection, toolName, tools) }] };
  }
  const result = await defineJsonSchema(tool.inputSchema as JsonObject)["~standard"].validate(
    isObject(input) ? input : {},
  );
  if (result.issues === undefined) return { input: result.value as JsonObject, tool };
  return {
    issues: [
      ...result.issues,
      { message: `Signature: ${connectionToolSignature(connection, tool)}` },
    ],
  };
}

/** The issues as one error message, each led by the path it is about. */
function issuesMessage(issues: readonly StandardSchemaV1.Issue[]): string {
  return issues
    .map(({ message, path = [] }) => {
      const at = path
        .map((segment) => (typeof segment === "object" ? String(segment.key) : String(segment)))
        .join(".");
      return at.length > 0 ? `${at}: ${message}` : message;
    })
    .join(" ");
}

function unknownToolMessage(
  connection: ResolvedConnectionDefinition,
  toolName: string,
  tools: readonly ConnectionToolMetadata[],
): string {
  const { connectionName } = connection;
  const suggestions = closestNames(toolName, tools).map((name) =>
    connectionToolName(connectionName, name),
  );
  const hint =
    suggestions.length > 0
      ? ` Closest tools: ${suggestions.join(", ")}.`
      : ` Find its tools with ${SEARCH_TOOL_NAME}({ query: "${connectionName}__" }).`;
  return `Connection "${connectionName}" has no tool named "${toolName}".${hint}`;
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
