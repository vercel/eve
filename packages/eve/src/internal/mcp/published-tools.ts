import {
  fromJsonSchema,
  inputResponse,
  type McpJsonObject,
} from "#compiled/@modelcontextprotocol/server/index.js";

import type { AgentToolDescription } from "#channel/agent-description.js";
import type {
  InvokeToolFn,
  InvokeToolOptions,
  InvokeToolResult,
  InvokeToolSignIn,
} from "#channel/invoke-tool.js";
import type { SessionAuthContext } from "#channel/types.js";
import { createLogger } from "#internal/logging.js";
import {
  hashCaller,
  hashToolArguments,
  type McpRequestState,
  type McpRequestStatePayload,
} from "#internal/mcp/request-state.js";
import {
  defineMcpTool,
  McpToolOperationError,
  type McpCallToolResult,
  type McpInputRequiredResult,
  type McpServerTool,
  type McpToolCallContext,
} from "#internal/mcp/streamable-http-server.js";
import { isObject } from "#shared/guards.js";
import { isJsonObjectValue, type JsonValue } from "#shared/json.js";

/** Input request key of an approval question. */
export const MCP_APPROVAL_KEY = "dev.eve/approval";
/** Prefix of a sign-in's input request key; the connection name follows. */
export const MCP_AUTHORIZATION_KEY_PREFIX = "dev.eve/authorization:";

const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";

const log = createLogger("mcp.tools");
const warnedReserved = new Set<string>();

/**
 * The agent's invocable tools as MCP tools. Each `tools/call` runs the tool
 * through `invokeTool` as the route-authenticated caller. Tools named like
 * one in `reserved` are skipped, since the channel serves that name itself.
 *
 * A call that needs approval or a sign-in answers `input_required`, when the
 * client declared that elicitation mode, with a signed `requestState`. The
 * client retries with the answer and the state; the retry runs `invokeTool`
 * again, so approval is evaluated again and the state grants nothing.
 */
export function createPublishedTools(input: {
  readonly invokeTool: InvokeToolFn;
  readonly requestState: McpRequestState;
  readonly reserved: ReadonlySet<string>;
  readonly tools: readonly AgentToolDescription[];
}): McpServerTool[] {
  return input.tools
    .filter((tool) => {
      if (!input.reserved.has(tool.name)) return true;
      if (!warnedReserved.has(tool.name)) {
        warnedReserved.add(tool.name);
        log.warn(
          `mcpChannel does not publish the tool "${tool.name}": the channel serves that name.`,
        );
      }
      return false;
    })
    .map((tool) =>
      defineMcpTool({
        definition: {
          description: tool.description,
          inputSchema: fromJsonSchema(tool.inputSchema),
          name: tool.name,
          outputSchema:
            tool.outputSchema === undefined ? undefined : fromJsonSchema(tool.outputSchema),
        },
        async call(value, context) {
          const { auth } = context;
          if (auth === null) {
            throw new McpToolOperationError("denied", "The channel authenticated no caller.");
          }
          return await callPublishedTool(input, {
            args: value,
            auth,
            context,
            hasOutputSchema: tool.outputSchema !== undefined,
            name: tool.name,
          });
        },
      }),
    );
}

/** A payload to mint; `mint` fills in `expiresAt` when it is absent. */
type MintPayload = Writable<Omit<McpRequestStatePayload, "expiresAt">> & { expiresAt?: number };
type Writable<T> = { -readonly [K in keyof T]: T[K] };

interface PublishedCall {
  readonly args: unknown;
  readonly auth: SessionAuthContext;
  readonly context: McpToolCallContext;
  readonly hasOutputSchema: boolean;
  readonly name: string;
}

async function callPublishedTool(
  input: { readonly invokeTool: InvokeToolFn; readonly requestState: McpRequestState },
  call: PublishedCall,
): Promise<McpCallToolResult<JsonValue> | McpInputRequiredResult> {
  const options: { -readonly [K in keyof InvokeToolOptions]: InvokeToolOptions[K] } = {
    auth: call.auth,
    signal: call.context.signal,
  };
  // The SDK already checked the MAC and expiry, or answered -32602. Left is
  // the binding: the same caller, tool, and arguments the state was minted
  // for. The SDK reports a handler's throw as a tool error, not -32602.
  const state = call.context.request.requestState<McpRequestStatePayload>();
  if (state !== undefined) {
    if (
      state.tool !== call.name ||
      state.args !== hashToolArguments(call.args) ||
      state.caller !== hashCaller(call.auth)
    ) {
      throw new McpToolOperationError(
        "invalid_input",
        "Invalid requestState: it was issued for another caller, tool, or arguments.",
      );
    }
    options.callId = state.callId;
    const responses = call.context.request.inputResponses;
    if (state.kind === "approval") {
      const answer = readApprovalAnswer(responses);
      if (answer !== undefined) options.approval = answer;
    } else {
      if (state.approval !== undefined) options.approval = state.approval;
      // Nothing runs until every sign-in has an answer: an existing grant
      // does not stand in for the person's reply.
      const answers = readSignInAnswers(responses, state.signIns ?? []);
      if (answers === "declined") {
        throw new McpToolOperationError("denied", `The sign-in for "${call.name}" was declined.`);
      }
      if (answers === "missing") return await signInRequired(input.requestState, state);
    }
  }
  const result = await input.invokeTool(call.name, call.args, options);
  return await toCallToolResult(input.requestState, call, result, {
    approval: options.approval,
    previous: state,
  });
}

async function toCallToolResult(
  requestState: McpRequestState,
  call: PublishedCall,
  result: InvokeToolResult,
  round: {
    readonly approval: { readonly approved: boolean } | undefined;
    readonly previous: McpRequestStatePayload | undefined;
  },
): Promise<McpCallToolResult<JsonValue> | McpInputRequiredResult> {
  const { hasOutputSchema, name } = call;
  switch (result.status) {
    case "completed": {
      const output = result.output as JsonValue;
      const text =
        result.modelOutput.type === "text"
          ? result.modelOutput.value
          : JSON.stringify(output ?? null);
      // A declared outputSchema obliges structured content of any JSON type: the
      // SDK rejects a result without it and wraps non-objects as `{ result }` on
      // 2025 connections. Without a schema, only objects are structured.
      return hasOutputSchema || isJsonObjectValue(output)
        ? { content: [{ text, type: "text" }], structuredContent: output ?? null }
        : { content: [{ text, type: "text" }] };
    }
    case "invalid-input":
      throw new McpToolOperationError("invalid_input", result.message);
    case "denied":
      throw new McpToolOperationError(
        "denied",
        result.reason ?? `The tool "${name}" was denied by its approval policy.`,
      );
    case "approval-required": {
      if (!clientSupports(call.context, "form")) {
        throw new McpToolOperationError(
          "approval_required",
          `The tool "${name}" needs a person's approval, and this MCP client did not declare form elicitation, so it cannot be asked. Call it from a conversation instead.`,
        );
      }
      const minter = requireMinter(requestState);
      const state = await minter.mint({
        ...binding(call, result.callId),
        kind: "approval",
      });
      return {
        inputRequests: {
          [MCP_APPROVAL_KEY]: {
            method: "elicitation/create",
            params: {
              message: `Allow the tool "${name}" to run?`,
              mode: "form",
              requestedSchema: {
                properties: { approved: { title: "Approve", type: "boolean" } },
                required: ["approved"],
                type: "object",
              },
            },
          },
        },
        requestState: state,
        resultType: "input_required",
      };
    }
    case "authorization-required": {
      const connections = result.signIns.map((signIn) => signIn.connection).join(", ");
      if (
        !clientSupports(call.context, "url") ||
        result.signIns.some((signIn) => signIn.url === undefined)
      ) {
        throw new McpToolOperationError(
          "authorization_required",
          `The tool "${name}" needs a sign-in to ${connections}, which this MCP client cannot be asked for (it needs URL elicitation and a sign-in page). Sign in from a conversation, then call it again.`,
        );
      }
      const payload: MintPayload = {
        ...binding(call, result.callId),
        kind: "authorization",
        signIns: result.signIns,
      };
      // A sign-in that is still missing after the person said they were
      // done keeps the round's first expiry.
      if (round.previous?.kind === "authorization") payload.expiresAt = round.previous.expiresAt;
      if (round.approval !== undefined) payload.approval = round.approval;
      return await signInRequired(requestState, payload);
    }
    case "failed":
      throw new McpToolOperationError("internal", result.message);
  }
}

function binding(call: PublishedCall, callId: string) {
  return {
    args: hashToolArguments(call.args),
    callId,
    caller: hashCaller(call.auth),
    tool: call.name,
    v: 1 as const,
  };
}

function requireMinter(requestState: McpRequestState) {
  if (requestState.kind === "missing") {
    throw new McpToolOperationError("internal", requestState.reason);
  }
  return requestState;
}

async function signInRequired(
  requestState: McpRequestState,
  payload: Omit<McpRequestStatePayload, "expiresAt"> & { readonly expiresAt?: number },
): Promise<McpInputRequiredResult> {
  const state = await requireMinter(requestState).mint(payload);
  const signIns = payload.signIns ?? [];
  return {
    inputRequests: Object.fromEntries(
      signIns.map((signIn) => [
        `${MCP_AUTHORIZATION_KEY_PREFIX}${signIn.connection}`,
        {
          method: "elicitation/create",
          params: { message: signInMessage(signIn), mode: "url", url: signIn.url },
        },
      ]),
    ),
    requestState: state,
    resultType: "input_required",
  };
}

function signInMessage(signIn: InvokeToolSignIn): string {
  const code = signIn.userCode === undefined ? "" : ` Code: ${signIn.userCode}`;
  return `Sign in to ${signIn.connection} to continue.${code}`;
}

/**
 * Accept with `approved: true` approves; accept with `approved: false`,
 * decline, and cancel deny. Anything else is no answer, and the caller is
 * asked again.
 */
function readApprovalAnswer(
  responses: McpJsonObject | undefined,
): { readonly approved: boolean } | undefined {
  const view = inputResponse(responses, MCP_APPROVAL_KEY);
  if (view.kind !== "elicit") return undefined;
  if (view.action === "decline" || view.action === "cancel") return { approved: false };
  const approved = view.content?.approved;
  return typeof approved === "boolean" ? { approved } : undefined;
}

/** Any decline or cancel declines the round; any sign-in without an accept leaves it open. */
function readSignInAnswers(
  responses: McpJsonObject | undefined,
  signIns: readonly InvokeToolSignIn[],
): "accepted" | "declined" | "missing" {
  let missing = signIns.length === 0;
  for (const signIn of signIns) {
    const view = inputResponse(responses, `${MCP_AUTHORIZATION_KEY_PREFIX}${signIn.connection}`);
    if (view.kind !== "elicit") missing = true;
    else if (view.action === "decline" || view.action === "cancel") return "declined";
  }
  return missing ? "missing" : "accepted";
}

/**
 * Whether the request's declared capabilities cover an elicitation mode, by
 * the SDK's rule: `elicitation: {}` implies form, URL must be named. eve
 * serves 2025-11-25 statelessly, so a `tools/call` from that era never sees
 * the `initialize` capabilities, and its clients always get the errors.
 */
function clientSupports(context: McpToolCallContext, mode: "form" | "url"): boolean {
  const declared = context.request.envelope?.[CLIENT_CAPABILITIES_KEY];
  if (!isObject(declared) || !isObject(declared.elicitation)) return false;
  const elicitation = declared.elicitation;
  if (mode === "url") return elicitation.url !== undefined;
  return elicitation.form !== undefined || elicitation.url === undefined;
}
