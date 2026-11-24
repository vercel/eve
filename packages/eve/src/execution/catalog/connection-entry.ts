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
  type ConnectionToolAnnotations,
} from "#approval/definition.js";
import { withAgentApproval } from "#approval/agent.js";
import { isConnectionAuthorizationRequiredError } from "#connections/errors.js";
import { connectionToolName } from "#connections/ownership.js";
import { loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { isApprovalRecheck, inheritApprovalContext } from "#approval/evaluation.js";
import { approvalDecision } from "#approval/status.js";
import { isAuthorizationSignal, type AuthorizationSignal } from "#harness/authorization.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { withConnectionApproval } from "#runtime/connections/approval-scope.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import {
  connectionToolModelOutput,
  toConnectionToolResult,
} from "#runtime/connections/tool-result.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import type { ConnectionClient, ConnectionToolMetadata } from "#shared/connection-types.js";
import { displayProperName, displayTitle } from "#protocol/session-projection/display-name.js";
import { isObject } from "#shared/guards.js";
import type { JsonObject } from "#shared/json.js";
import type { ToolExecuteOptions } from "#tools/definition.js";
import { defineJsonSchema, refineJsonSchema } from "#tools/schema.js";
import { SEARCH_TOOL_NAME } from "#protocol/catalog-tools.js";

import {
  authorizationRequired,
  completeConnectionSignIn,
  listConnectionTools,
  listingFailureMessage,
  listToolMetadata,
} from "./connection-auth.js";
import { closestNames } from "./rank.js";
import { connectionToolSignature } from "./signatures.js";

const MAX_APPROVAL_PINS = 50;

const CONNECTION_CHANGED_MESSAGE =
  "The connection for this tool call changed or is unavailable. Request a new tool call and approval.";

const ConnectionApprovalPinsKey = new ContextKey<Readonly<Record<string, string>>>(
  "eve.connectionApprovalPins",
);

function instanceKey(connection: ResolvedConnectionDefinition): string {
  return connection.instanceId ?? "";
}

const CHANGED_INSTANCE = "\u0000changed";

export function connectionEntry(
  registry: ConnectionRegistry,
  connection: ResolvedConnectionDefinition,
  toolName: string,
  agentApproval?: ApprovalPolicy,
): HarnessToolDefinition {
  const label = `${displayProperName(connection.connectionName)}: ${displayTitle(toolName)}`;
  const approval = withAgentApproval(agentApproval, connection.approval);
  return {
    approval: connectionApproval(connection, approval, () =>
      toolAnnotations(registry, connection, toolName),
    ),
    deferred: true,
    description: "",
    execute: (input: unknown, options: ToolExecuteOptions) =>
      callConnectionTool(registry, connection, toolName, input, options, approval !== undefined),
    inputSchema: refineJsonSchema({}, (input) => checkInput(registry, connection, toolName, input)),
    label: { start: () => label },
    name: connectionToolName(connection.connectionName, toolName),
    toModelOutput: connectionToolModelOutput,
  };
}

export function connectionEventActionApproval(
  connection: ResolvedConnectionDefinition,
): Approval | undefined {
  return connectionApproval(connection, connection.approval, async () => undefined);
}

export async function runConnectionEventAction(
  registry: ConnectionRegistry,
  connection: ResolvedConnectionDefinition,
  action: string,
  input: unknown,
  options: ToolExecuteOptions,
): Promise<unknown> {
  releaseApprovalPin(options.toolCallId, connection);
  const session = await completeConnectionSignIn(registry, connection);
  const actions = session.client.eventActions;
  if (actions === undefined) throw new Error("Unknown subscription for this caller.");
  try {
    return await withConnectionApproval(
      connection.connectionName,
      options.approval?.responder,
      () =>
        actions.execute(action, input, {
          abortSignal: options.abortSignal,
          callId: options.toolCallId,
        }),
    );
  } catch (error) {
    if (!isConnectionAuthorizationRequiredError(error)) throw error;
    const required = authorizationRequired(connection.connectionName, session, error);
    if ("failure" in required) throw new Error(required.failure);
    const signal = await session.auth.handleError(required.error, required.authorization);
    if (connection.approval !== undefined && isAuthorizationSignal(signal))
      pinApprovedInstance(options.toolCallId, connection);
    return signal;
  }
}

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
  gated: boolean,
): Promise<unknown> {
  releaseApprovalPin(options.toolCallId, connection);
  const result = await runConnectionTool(registry, connection, toolName, rawInput, options);
  if (gated && isAuthorizationSignal(result)) {
    pinApprovedInstance(options.toolCallId, connection);
  }
  return result;
}

async function runConnectionTool(
  registry: ConnectionRegistry,
  connection: ResolvedConnectionDefinition,
  toolName: string,
  rawInput: unknown,
  options: ToolExecuteOptions,
): Promise<unknown> {
  const session = await completeConnectionSignIn(registry, connection);
  const { auth, client, scoped } = session;
  const listing = await listConnectionTools(connection, session);
  if ("failure" in listing) throw new Error(listing.failure);
  if ("authorization" in listing) {
    return await auth.handleError(listing.error, listing.authorization);
  }
  const modelInput = withoutProvidedArguments(connection, rawInput);
  const checked = await checkCall(connection, listing.tools, toolName, modelInput);
  if ("issues" in checked) throw new Error(issuesMessage(checked.issues));
  const { input, tool } = checked;

  let raw: unknown;
  try {
    const approved = <T>(fn: () => T) =>
      withConnectionApproval(connection.connectionName, options.approval?.responder, fn);
    raw = await approved(() =>
      executeWithDeadline(connection.connectionName, client, tool.name, input, options),
    );
  } catch (error) {
    if (isConnectionAuthorizationRequiredError(error)) return await auth.handleError(error, scoped);
    throw error;
  }

  const result = toConnectionToolResult(connection.protocol, tool, raw);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

const CALL_TIMEOUT_MS = 5 * 60_000;

async function executeWithDeadline(
  connectionName: string,
  client: ConnectionClient,
  toolName: string,
  input: unknown,
  options: ToolExecuteOptions,
): Promise<unknown> {
  const turn = options.abortSignal;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), CALL_TIMEOUT_MS);
  try {
    return await client.executeTool(toolName, input, {
      abortSignal: turn === undefined ? deadline.signal : AbortSignal.any([turn, deadline.signal]),
      callId: options.toolCallId,
    });
  } catch (error) {
    if (!deadline.signal.aborted || turn?.aborted === true) throw error;
    throw new Error(
      `"${connectionName}" did not answer ${toolName} within ${CALL_TIMEOUT_MS / 60_000} minutes. It may still have run, so check before you retry.`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}

async function checkInput(
  registry: ConnectionRegistry,
  connection: ResolvedConnectionDefinition,
  toolName: string,
  input: unknown,
): Promise<StandardSchemaV1.Result<unknown>> {
  const client = registry.getClient(connection.connectionName);
  let tools: readonly ConnectionToolMetadata[];
  try {
    tools = await listToolMetadata(connection, client);
  } catch (error) {
    if (isConnectionAuthorizationRequiredError(error)) return { value: input };
    return { issues: [{ message: listingFailureMessage(connection.connectionName, error) }] };
  }
  const modelInput = withoutProvidedArguments(connection, input);
  const checked = await checkCall(connection, tools, toolName, modelInput);
  return "issues" in checked ? { issues: checked.issues } : { value: modelInput };
}

type CallCheck =
  | { readonly input: JsonObject; readonly tool: ConnectionToolMetadata }
  | { readonly issues: readonly StandardSchemaV1.Issue[] };

function withoutProvidedArguments(
  connection: ResolvedConnectionDefinition,
  input: unknown,
): Record<string, unknown> {
  const provided = connection.toolCall?.providedArguments ?? {};
  return Object.fromEntries(
    Object.entries(isObject(input) ? input : {}).filter(([key]) => !Object.hasOwn(provided, key)),
  );
}

async function checkCall(
  connection: ResolvedConnectionDefinition,
  tools: readonly ConnectionToolMetadata[],
  toolName: string,
  input: Record<string, unknown>,
): Promise<CallCheck> {
  const tool = tools.find((entry) => entry.name === toolName);
  if (tool === undefined) {
    return { issues: [{ message: unknownToolMessage(connection, toolName, tools) }] };
  }
  const result = await defineJsonSchema(tool.inputSchema as JsonObject)["~standard"].validate(
    input,
  );
  if (result.issues === undefined) return { input: result.value as JsonObject, tool };
  return {
    issues: [
      ...result.issues,
      { message: `Signature: ${connectionToolSignature(connection, tool)}` },
    ],
  };
}

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

function connectionApproval(
  connection: ResolvedConnectionDefinition,
  approval: Approval | undefined,
  annotations: () => Promise<ConnectionToolAnnotations | undefined>,
): Approval | undefined {
  if (approval === undefined) return undefined;
  const policy = resolveApprovalPolicy(approval);
  const request = async (context: ApprovalContext) =>
    requestApproval(connection, policy, withToolAnnotations(context, await annotations()));
  if (typeof approval === "function") return request;
  const response = approval.response;
  return {
    request,
    prompt: approval.prompt,
    response:
      response === undefined
        ? undefined
        : (context: ApprovalResponseContext) =>
            authorizeApprovalResponse(connection, response, context),
  };
}

async function requestApproval(
  connection: ResolvedConnectionDefinition,
  policy: ApprovalPolicy,
  context: ApprovalContext,
): Promise<ApprovalStatus> {
  if (isApprovalRecheck(context) && !matchesApprovalPin(context.callId, connection)) {
    markApprovalPinChanged(context.callId);
  }
  const status = await policy(context);
  if (!isApprovalRecheck(context) && approvalDecision(status).awaitsPerson === true) {
    pinApprovedInstance(context.callId, connection);
  }
  return status;
}

async function toolAnnotations(
  registry: ConnectionRegistry,
  connection: ResolvedConnectionDefinition,
  toolName: string,
): Promise<ConnectionToolAnnotations | undefined> {
  try {
    const tools = await listToolMetadata(connection, registry.getClient(connection.connectionName));
    return tools.find((tool) => tool.name === toolName)?.annotations;
  } catch {
    return undefined;
  }
}

function withToolAnnotations(
  context: ApprovalContext,
  annotations: ConnectionToolAnnotations | undefined,
): ApprovalContext {
  if (annotations === undefined) return context;
  return inheritApprovalContext(context, { ...context, toolAnnotations: annotations });
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
