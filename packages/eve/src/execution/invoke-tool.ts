import { asSchema } from "ai";

import { resolveApprovalPolicy, type ApprovalStatus } from "#approval/definition.js";
import type { InvokeToolOptions, InvokeToolResult } from "#channel/invoke-tool.js";
import {
  compiledToolOwner,
  type CompiledToolBindings,
  isInvocableCompiledTool,
} from "#channel/tool-eligibility.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { CompiledToolDefinition } from "#compiler/manifest.js";
import { isConnectionAuthorizationFailedError } from "#connections/errors.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, InitiatorAuthKey, SandboxKey, SessionIdKey, SessionKey } from "#context/keys.js";
import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import {
  AuthorizationHookKey,
  CallbackBaseUrlKey,
  isAuthorizationSignal,
} from "#harness/authorization.js";
import { normalizeToolJsonOutput, normalizeToolModelOutput } from "#harness/tool-model-output.js";
import type { HarnessToolMap } from "#harness/types.js";
import { createLogger, logError } from "#internal/logging.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { isAsyncIterable } from "#shared/async-iterable.js";
import { toErrorMessage } from "#shared/errors.js";
import { isObject } from "#shared/guards.js";
import type { SandboxAccess } from "#sandbox/state.js";
import { createUlid } from "#shared/ulid.js";
import { type InvokeToolTraceOrigin, withInvokeToolSpan } from "#tracing/invoke-tool-span.js";
import type { ToolExecuteOptions } from "#tools/definition.js";
import type { ToolModelOutput } from "#tools/model-output.js";

const log = createLogger("invoke-tool");

/** What `invokeTool` needs from the agent: its static tools and sandbox. */
export interface InvokeToolRuntime {
  /** Present in a deployed agent so framework helpers can reach the compiled graph. */
  readonly bundle?: CompiledRuntimeAgentBundle;
  /** Base URL for framework callbacks, such as the page a sign-in lands on. */
  readonly callbackBaseUrl: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  /** The root node's compiled tools and source bindings, which decide invocability. */
  readonly manifest: InvokeToolManifest;
  readonly nodeId: string;
  /** The channel the call arrived on, for trace policy and span attributes. */
  readonly origin?: InvokeToolTraceOrigin;
  readonly sandboxRegistry: RuntimeSandboxRegistry;
  /** Static tools only: dynamic resolvers never run outside a turn. */
  readonly tools: HarnessToolMap;
}

/** The part of a compiled manifest `invokeTool` reads to decide invocability. */
export interface InvokeToolManifest extends CompiledToolBindings {
  readonly tools: readonly Pick<
    CompiledToolDefinition,
    "behavior" | "hasExecute" | "name" | "sourceId"
  >[];
}

/** Why a compiled tool cannot run outside a turn, or `undefined` when it can. */
function ineligibility(
  manifest: InvokeToolManifest,
  tool: InvokeToolManifest["tools"][number],
): string | undefined {
  // `isInvocableCompiledTool` is the one rule, shared with `describe()`; the
  // reason below only words the refusal.
  if (isInvocableCompiledTool(manifest, tool)) return undefined;
  if (compiledToolOwner(manifest, tool).kind === "framework") {
    return "it is a framework tool, which needs a conversation";
  }
  if (tool.behavior?.handling !== undefined) {
    return "the harness or the model provider runs it, not its execute";
  }
  return "it has no server-side execute";
}

/**
 * Runs one tool outside a turn; see `InvokeToolFn` for the contract. Each call
 * gets a fresh session id, so nothing it opens is shared with another call.
 */
export async function invokeTool(
  runtime: InvokeToolRuntime,
  name: string,
  input: unknown,
  options: InvokeToolOptions,
): Promise<InvokeToolResult> {
  const compiled = runtime.manifest.tools.find((tool) => tool.name === name);
  const definition = runtime.tools.get(name);
  if (compiled === undefined || definition === undefined) {
    return failed(`The agent has no tool named "${name}".`);
  }
  const ineligible =
    ineligibility(runtime.manifest, compiled) ??
    (definition.execute === undefined ? "it has no server-side execute" : undefined);
  if (ineligible !== undefined) {
    return failed(`Tool "${name}" cannot be invoked outside a conversation: ${ineligible}.`);
  }

  const callId = `call_${createUlid()}`;
  const sessionId = `call_session_${createUlid()}`;
  return await withInvokeToolSpan(
    { auth: options.auth, callId, input, origin: runtime.origin, sessionId, toolName: name },
    () => runInvocation({ callId, definition, input, name, options, runtime, sessionId }),
  );
}

async function runInvocation(input: {
  readonly callId: string;
  readonly definition: HarnessToolDefinition;
  readonly input: unknown;
  readonly name: string;
  readonly options: InvokeToolOptions;
  readonly runtime: InvokeToolRuntime;
  readonly sessionId: string;
}): Promise<InvokeToolResult> {
  const { callId, definition, name, options, runtime, sessionId } = input;
  const validated = await validateToolInput(definition, input.input);
  if (validated.kind === "threw")
    return failedFromError(validated.error, name, "input validation failed");
  if (validated.kind === "invalid") return { message: validated.message, status: "invalid-input" };

  const sandbox = await callSandbox(runtime, sessionId);
  const context = createCallContext({
    auth: options.auth,
    callId,
    callbackBaseUrl: runtime.callbackBaseUrl,
    sessionId,
  });
  context.setVirtualContext(SandboxKey, sandbox.access);
  if (runtime.bundle !== undefined) context.setVirtualContext(BundleKey, runtime.bundle);

  try {
    return await contextStorage.run(context, () =>
      runCall({ callId, definition, input: validated.value, signal: options.signal }),
    );
  } finally {
    await sandbox.release().catch((error: unknown) => {
      logError(log, "failed to delete a call's sandbox", error, { sessionId, toolName: name });
    });
  }
}

/** The call's sandbox: opened on the first `ctx.getSandbox()`, deleted after the call. */
async function callSandbox(
  runtime: InvokeToolRuntime,
  sessionId: string,
): Promise<{ readonly access: SandboxAccess; release(): Promise<void> }> {
  const inner = await ensureSandboxAccess({
    compiledArtifactsSource: runtime.compiledArtifactsSource,
    nodeId: runtime.nodeId,
    ownsSandbox: true,
    registry: runtime.sandboxRegistry,
    sessionId,
    state: null,
  });
  // The latest requested open, kept before it settles: `execute` can finish
  // (say, by losing a race against cancellation) while the provider is still
  // starting, and release must still delete what that start creates.
  let requested: Promise<unknown> | undefined;
  return {
    access: {
      ...inner,
      get() {
        const opening = inner.get();
        requested = opening;
        return opening;
      },
    },
    async release() {
      if (requested === undefined) return;
      // A failed open left nothing behind; deleting would open one just to delete it.
      const sandbox = await requested.catch(() => null);
      if (sandbox !== null) await inner.delete?.();
    },
  };
}

function createCallContext(input: {
  readonly auth: SessionAuthContext;
  readonly callId: string;
  readonly callbackBaseUrl: string;
  readonly sessionId: string;
}): ContextContainer {
  const context = new ContextContainer();
  context.set(AuthKey, input.auth);
  context.set(InitiatorAuthKey, input.auth);
  context.set(SessionIdKey, input.sessionId);
  // No turn exists; the stand-in names the call, as sandbox setup outside a turn does.
  context.setVirtualContext(SessionKey, {
    auth: { current: input.auth, initiator: input.auth },
    sessionId: input.sessionId,
    turn: { id: input.callId, sequence: 0 },
  });
  context.set(CallbackBaseUrlKey, input.callbackBaseUrl.replace(/\/$/, ""));
  // Sign-in callbacks have no parked run to resume; the URL is only a landing page.
  context.setVirtualContext(AuthorizationHookKey, `invoke-tool:${input.callId}`);
  return context;
}

async function runCall(input: {
  readonly callId: string;
  readonly definition: HarnessToolDefinition;
  readonly input: unknown;
  readonly signal: AbortSignal | undefined;
}): Promise<InvokeToolResult> {
  const { callId, definition } = input;
  const signal = input.signal ?? new AbortController().signal;

  if (definition.approval !== undefined) {
    let status: ApprovalStatus;
    try {
      status = await resolveApprovalPolicy(definition.approval)({
        ...buildCallbackContext(),
        abortSignal: signal,
        approvedTools: new Set<string>(),
        callId,
        toolInput: isObject(input.input) ? input.input : undefined,
        toolName: definition.name,
      });
    } catch (error) {
      return failedFromError(error, definition.name, "approval policy failed");
    }
    const decision = decideApproval(status);
    if (decision.kind === "denied") return denied(decision.reason);
    if (decision.kind === "user-approval") return { status: "approval-required" };
  }

  const executeOptions: ToolExecuteOptions = {
    abortSignal: signal,
    messages: [],
    toolCallId: callId,
  };
  let output: unknown;
  try {
    output = await definition.execute!(input.input, executeOptions);
    if (isAsyncIterable(output)) output = await lastIterated(output);
  } catch (error) {
    if (isConnectionAuthorizationFailedError(error)) {
      return failed(toErrorMessage(error));
    }
    return failedFromError(error, definition.name, "tool execution failed");
  }
  if (isAuthorizationSignal(output)) {
    return {
      connections: output.challenges.map((challenge) => challenge.name),
      status: "authorization-required",
    };
  }

  try {
    const json = normalizeToolJsonOutput({
      boundary: "execute",
      output,
      toolCallId: callId,
      toolName: definition.name,
    });
    return {
      modelOutput: await toModelOutput(definition, json, callId),
      output: json,
      status: "completed",
    };
  } catch (error) {
    return failedFromError(error, definition.name, "tool output could not be serialized");
  }
}

function decideApproval(
  status: ApprovalStatus,
):
  | { readonly kind: "run" }
  | { readonly kind: "user-approval" }
  | { readonly kind: "denied"; readonly reason?: string } {
  if (status === true || status === "user-approval") return { kind: "user-approval" };
  if (status === "denied") return { kind: "denied" };
  if (typeof status === "object" && status !== null) {
    if (status.type === "user-approval") return { kind: "user-approval" };
    if (status.type === "denied") return { kind: "denied", reason: status.reason };
  }
  return { kind: "run" };
}

async function validateToolInput(
  definition: HarnessToolDefinition,
  input: unknown,
): Promise<
  | { readonly kind: "valid"; readonly value: unknown }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "threw"; readonly error: unknown }
> {
  let result: Awaited<ReturnType<NonNullable<ReturnType<typeof asSchema>["validate"]>>>;
  try {
    // Inside the try: normalizing a malformed schema throws just like a validator.
    const schema = asSchema(definition.inputSchema);
    if (schema.validate === undefined) return { kind: "valid", value: input };
    result = await schema.validate(input);
  } catch (error) {
    // A validator that throws failed itself; its message is not a diagnostic of the input.
    return { error, kind: "threw" };
  }
  // A structured failure describes the input, so it goes back verbatim.
  return result.success
    ? { kind: "valid", value: result.value }
    : {
        kind: "invalid",
        message: `Invalid input for tool "${definition.name}": ${toErrorMessage(result.error)}`,
      };
}

async function toModelOutput(
  definition: HarnessToolDefinition,
  output: unknown,
  callId: string,
): Promise<ToolModelOutput> {
  if (definition.toModelOutput !== undefined) {
    return normalizeToolModelOutput({
      output: await definition.toModelOutput(output),
      toolCallId: callId,
      toolName: definition.name,
    }) as ToolModelOutput;
  }
  if (typeof output === "string") return { type: "text", value: output };
  return normalizeToolModelOutput({
    output: { type: "json", value: output ?? null },
    toolCallId: callId,
    toolName: definition.name,
  }) as ToolModelOutput;
}

async function lastIterated(iterable: AsyncIterable<unknown>): Promise<unknown> {
  let last: unknown;
  for await (const value of iterable) last = value;
  return last;
}

function denied(reason: string | undefined): InvokeToolResult {
  return reason === undefined ? { status: "denied" } : { reason, status: "denied" };
}

function failed(message: string): InvokeToolResult {
  return { message, status: "failed" };
}

/**
 * Logs the error under a fresh id and returns that id with a generic message:
 * an unexpected error's text can carry paths, hosts, or secrets.
 */
function failedFromError(error: unknown, toolName: string, what: string): InvokeToolResult {
  const errorId = logError(log, `invokeTool ${what}`, error, { toolName });
  return {
    errorId,
    message: `Tool "${toolName}" failed: ${what}. The error is logged with id ${errorId}.`,
    status: "failed",
  };
}
