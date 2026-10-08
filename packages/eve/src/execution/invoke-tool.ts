import { context as otelContext, trace } from "#compiled/@opentelemetry/api/index.js";

import { resolveApprovalPolicy, type ApprovalStatus } from "#approval/definition.js";
import type { InvokeToolOptions, InvokeToolResult } from "#channel/invoke-tool.js";
import {
  compiledToolOwner,
  type CompiledToolBindings,
  isInvocableCompiledTool,
} from "#channel/tool-eligibility.js";
import { isAnonymousPrincipal } from "#channel/principal-identity.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { CompiledToolDefinition } from "#compiler/manifest.js";
import { isConnectionAuthorizationFailedError } from "#connections/errors.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, InitiatorAuthKey, SandboxKey, SessionIdKey, SessionKey } from "#context/keys.js";
import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import { deriveToolSessionId, validateToolSessionKey } from "#execution/tool-session/id.js";
import {
  assertToolSessionSandboxSupport,
  releaseToolSessionHandle,
  ToolSessionSandboxUnsupportedError,
} from "#execution/tool-session/sandbox.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import {
  AuthorizationHookKey,
  CallbackBaseUrlKey,
  isAuthorizationSignal,
  modelFacingAuthorizationOutput,
} from "#harness/authorization.js";
import { checkToolCallInput, toolCallModelOutput } from "#harness/tool-call-io.js";
import { normalizeToolJsonOutput } from "#harness/tool-model-output.js";
import type { HarnessToolMap } from "#harness/types.js";
import { createLogger, logError } from "#internal/logging.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { isAsyncIterable } from "#shared/async-iterable.js";
import { toErrorMessage } from "#shared/errors.js";
import type { JsonObject } from "#shared/json.js";
import type { SandboxAccess } from "#sandbox/state.js";
import { createUlid } from "#shared/ulid.js";
import {
  type InvokeToolObserver,
  type InvokeToolTraceOrigin,
  withInvokeToolSpan,
} from "#tracing/eve/invoke-tool-span.js";
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
  /** The agent's name, for trace policy and `gen_ai.agent.name`. */
  readonly agentName: string;
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
 * Runs one tool outside a turn; see `InvokeToolFn` for the contract. A call
 * without a key gets a fresh session id, so nothing it opens is shared with
 * another call. A keyed call derives its session id from the caller and key.
 * Either way the session's authored state is call-scoped: tool sessions keep
 * only their sandbox. An anonymous caller is denied a keyed call: with one
 * shared principal, the key alone would name the session.
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

  const key = options.key;
  const keyProblem = key === undefined ? undefined : validateToolSessionKey(key);
  if (keyProblem !== undefined) return { message: keyProblem, status: "invalid-input" };
  // `none()` gives every caller one principal, so a key would be a shared secret
  // that opens the same sandbox to anyone who guesses it.
  if (key !== undefined && isAnonymousPrincipal(options.auth)) {
    return denied(
      "Tool sessions need an authenticated caller: an anonymous caller cannot send a key. " +
        "Call without a key for a one-off session.",
    );
  }

  const callId = `call_${createUlid()}`;
  // Each call is its own run in traces. A tool session id is stable per caller
  // and key, so it only finds the sandbox: as a run or conversation id it would
  // join calls days apart and show which calls came from the same caller.
  const runSessionId = `call_session_${createUlid()}`;
  const sessionId =
    key === undefined
      ? runSessionId
      : deriveToolSessionId({ current: options.auth, forwardedBy: options.forwardedBy, key });
  return await withInvokeToolSpan(
    {
      agentName: runtime.agentName,
      auth: options.auth,
      callId,
      origin: runtime.origin,
      sessionId: runSessionId,
      toolName: name,
    },
    (observer) =>
      runInvocation({ callId, definition, input, name, observer, options, runtime, sessionId }),
  );
}

async function runInvocation(input: {
  readonly callId: string;
  readonly definition: HarnessToolDefinition;
  readonly input: unknown;
  readonly name: string;
  readonly observer: InvokeToolObserver;
  readonly options: InvokeToolOptions;
  readonly runtime: InvokeToolRuntime;
  readonly sessionId: string;
}): Promise<InvokeToolResult> {
  const { callId, definition, name, observer, options, runtime, sessionId } = input;
  const validated = await checkToolCallInput(definition, input.input, callId);
  if (validated.kind === "threw") {
    observer.failedWith(validated.error);
    return failedFromError(validated.error, name, "input validation failed");
  }
  if (validated.kind === "invalid") return { message: validated.message, status: "invalid-input" };

  const sandbox =
    options.key === undefined
      ? await callSandbox(runtime, sessionId)
      : await keyedSandbox(runtime, sessionId);
  const context = createCallContext({
    auth: options.auth,
    initiator: options.initiator ?? options.auth,
    callId,
    callbackBaseUrl: runtime.callbackBaseUrl,
    sessionId,
  });
  context.setVirtualContext(SandboxKey, sandbox.access);
  if (runtime.bundle !== undefined) context.setVirtualContext(BundleKey, runtime.bundle);

  try {
    return await contextStorage.run(context, () =>
      runCall({
        callId,
        definition,
        input: validated.value,
        observer,
        signal: options.signal,
      }),
    );
  } finally {
    await sandbox.release().catch((error: unknown) => {
      logError(log, "failed to release a call's sandbox", error, { sessionId, toolName: name });
    });
  }
}

interface CallSandbox {
  readonly access: SandboxAccess;
  release(): Promise<void>;
}

/**
 * A keyed session's sandbox: found or created on the first `ctx.getSandbox()`
 * through the provider's `start`, which reopens it by session id, and kept
 * after the call. Concurrent first calls in this process share one start.
 * The call does not own the sandbox, so a failed start never deletes it, and
 * release only lets go of this call's handle: an overlapping call keeps its
 * own.
 */
async function keyedSandbox(runtime: InvokeToolRuntime, sessionId: string): Promise<CallSandbox> {
  const inner = await ensureSandboxAccess({
    compiledArtifactsSource: runtime.compiledArtifactsSource,
    nodeId: runtime.nodeId,
    ownsSandbox: false,
    registry: runtime.sandboxRegistry,
    sessionId,
    state: null,
  });
  return {
    access: {
      ...inner,
      async get() {
        assertToolSessionSandboxSupport(runtime.sandboxRegistry);
        return await inner.get();
      },
    },
    async release() {
      const handle = await inner.detach();
      if (handle !== undefined) await releaseToolSessionHandle(runtime.sandboxRegistry, handle);
    },
  };
}

/** The call's sandbox: opened on the first `ctx.getSandbox()`, deleted after the call. */
async function callSandbox(runtime: InvokeToolRuntime, sessionId: string): Promise<CallSandbox> {
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
  readonly initiator: SessionAuthContext;
  readonly callId: string;
  readonly callbackBaseUrl: string;
  readonly sessionId: string;
}): ContextContainer {
  const context = new ContextContainer();
  context.set(AuthKey, input.auth);
  context.set(InitiatorAuthKey, input.initiator);
  context.set(SessionIdKey, input.sessionId);
  // No turn exists; the stand-in names the call, as sandbox setup outside a turn does.
  context.setVirtualContext(SessionKey, {
    auth: { current: input.auth, initiator: input.initiator },
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
  readonly input: JsonObject;
  readonly observer: InvokeToolObserver;
  readonly signal: AbortSignal | undefined;
}): Promise<InvokeToolResult> {
  const { callId, definition, observer } = input;
  const signal = input.signal ?? new AbortController().signal;

  if (definition.approval !== undefined) {
    let status: ApprovalStatus;
    try {
      status = await resolveApprovalPolicy(definition.approval)({
        ...buildCallbackContext(),
        abortSignal: signal,
        approvedTools: new Set<string>(),
        callId,
        toolInput: input.input,
        toolName: definition.name,
      });
    } catch (error) {
      observer.failedWith(error);
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
  // `execute` and output serialization are one step, as in a conversation's wrapped execute.
  await observer.executing(input.input);
  let output: unknown;
  let json: unknown;
  let returned = false;
  // Started after the start event's handlers, and read once when execute settles.
  const startedAt = performance.now();
  const elapsed = () => performance.now() - startedAt;
  let durationMs: number;
  try {
    output = await definition.execute!(input.input, executeOptions);
    if (isAsyncIterable(output)) output = await lastIterated(output);
    returned = true;
    if (!isAuthorizationSignal(output)) {
      json = normalizeToolJsonOutput({
        boundary: "execute",
        output,
        toolCallId: callId,
        toolName: definition.name,
      });
    }
    durationMs = elapsed();
  } catch (error) {
    await observer.executed({ durationMs: elapsed(), error, type: "error" });
    observer.failedWith(error);
    if (returned) {
      return failedFromError(error, definition.name, "tool output could not be serialized");
    }
    if (
      isConnectionAuthorizationFailedError(error) ||
      error instanceof ToolSessionSandboxUnsupportedError
    ) {
      return failed(toErrorMessage(error));
    }
    return failedFromError(error, definition.name, "tool execution failed");
  }
  if (isAuthorizationSignal(output)) {
    await observer.executed({
      durationMs,
      output: modelFacingAuthorizationOutput(output),
      type: "result",
    });
    return {
      connections: output.challenges.map((challenge) => challenge.name),
      status: "authorization-required",
    };
  }
  await observer.executed({ durationMs, output: json, type: "result" });

  try {
    return {
      modelOutput: (await toolCallModelOutput(definition, json, callId)) as ToolModelOutput,
      output: json,
      status: "completed",
    };
  } catch (error) {
    observer.failedWith(error);
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
  // Off every span: the tool span records the failure itself, under its content decision.
  const errorId = otelContext.with(trace.deleteSpan(otelContext.active()), () =>
    logError(log, `invokeTool ${what}`, error, { toolName }),
  );
  return {
    errorId,
    message: `Tool "${toolName}" failed: ${what}. The error is logged with id ${errorId}.`,
    status: "failed",
  };
}
