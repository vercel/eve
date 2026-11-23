import { context as otelContext, trace } from "#compiled/@opentelemetry/api/index.js";

import { requireClearance } from "#harness/clearance.js";
import { decideApproval, type GateDecision } from "#harness/tools.js";
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
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, InitiatorAuthKey, SandboxKey, SessionIdKey, SessionKey } from "#context/keys.js";
import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import { deriveToolSessionId, validateToolSessionKey } from "#execution/tool-session/id.js";
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
import { compiledSessionAgent } from "#runtime/sessions/compiled-session-agent.js";
import { SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { isAsyncIterable } from "#shared/async-iterable.js";
import { toErrorMessage } from "#shared/errors.js";
import type { JsonObject } from "#shared/json.js";
import type { SandboxAccess } from "#sandbox/state.js";
import { ToolSessionSandboxUnsupportedError } from "#shared/sandbox-tool-session-error.js";
import { createUlid } from "#shared/ulid.js";
import {
  type InvokeToolObserver,
  type InvokeToolTraceOrigin,
  withInvokeToolSpan,
} from "#tracing/eve/invoke-tool-span.js";
import type { ToolExecuteOptions } from "#tools/definition.js";
import type { ToolModelOutput } from "#tools/model-output.js";

const log = createLogger("invoke-tool");

export interface InvokeToolRuntime {
  readonly bundle?: CompiledRuntimeAgentBundle;
  readonly callbackBaseUrl: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly manifest: InvokeToolManifest;
  readonly nodeId: string;
  readonly agentName: string;
  readonly origin?: InvokeToolTraceOrigin;
  readonly sandboxRegistry: RuntimeSandboxRegistry;
  readonly tools: HarnessToolMap;
}

export interface InvokeToolManifest extends CompiledToolBindings {
  readonly tools: readonly Pick<
    CompiledToolDefinition,
    "behavior" | "hasExecute" | "name" | "sourceId"
  >[];
}

function ineligibility(
  manifest: InvokeToolManifest,
  tool: InvokeToolManifest["tools"][number],
): string | undefined {
  if (isInvocableCompiledTool(manifest, tool)) return undefined;
  if (compiledToolOwner(manifest, tool).kind === "framework") {
    return "it is a framework tool, which needs a conversation";
  }
  if (tool.behavior?.handling !== undefined) {
    return "the harness or the model provider runs it, not its execute";
  }
  return "it has no server-side execute";
}

export async function invokeTool(
  runtime: InvokeToolRuntime,
  name: string,
  input: unknown,
  options: InvokeToolOptions,
): Promise<InvokeToolResult> {
  const callId = `call_${createUlid()}`;
  const runSessionId = `call_session_${createUlid()}`;
  return await withInvokeToolSpan(
    {
      agentName: runtime.agentName,
      auth: options.auth,
      callId,
      input,
      origin: runtime.origin,
      sessionId: runSessionId,
      toolName: name,
    },
    async (observer) => {
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
      if (keyProblem !== undefined) return failed(keyProblem, "INVALID_INPUT");
      if (key !== undefined && isAnonymousPrincipal(options.auth)) {
        return rejected(
          "Tool sessions need an authenticated caller: an anonymous caller cannot send a key. " +
            "Call without a key for a one-off session.",
        );
      }

      const sessionId =
        key === undefined
          ? runSessionId
          : deriveToolSessionId({ current: options.auth, forwardedBy: options.forwardedBy, key });
      return await runInvocation({
        callId,
        definition,
        input,
        name,
        observer,
        options,
        runtime,
        sessionId,
      });
    },
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
  if (validated.kind === "invalid") return failed(validated.message, "INVALID_INPUT");

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
  if (runtime.bundle !== undefined) {
    context.setVirtualContext(SessionAgentKey, await compiledSessionAgent(runtime.bundle));
  }

  try {
    return await contextStorage.run(context, () =>
      runCall({
        callId,
        definition,
        input: validated.value,
        observer,
        sandboxOutlivesCall: options.key !== undefined,
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

async function keyedSandbox(runtime: InvokeToolRuntime, sessionId: string): Promise<CallSandbox> {
  const access = await ensureSandboxAccess({
    compiledArtifactsSource: runtime.compiledArtifactsSource,
    nodeId: runtime.nodeId,
    ownsSandbox: false,
    registry: runtime.sandboxRegistry,
    sessionId,
    shutdownTracking: "call",
    state: null,
  });
  return { access, release: () => access.release() };
}

async function callSandbox(runtime: InvokeToolRuntime, sessionId: string): Promise<CallSandbox> {
  const access = await ensureSandboxAccess({
    compiledArtifactsSource: runtime.compiledArtifactsSource,
    nodeId: runtime.nodeId,
    ownsSandbox: true,
    registry: runtime.sandboxRegistry,
    sessionId,
    state: null,
  });
  let requested = false;
  return {
    access: {
      ...access,
      get() {
        requested = true;
        return access.get();
      },
    },
    async release() {
      if (requested) await access.end("completed");
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
  context.setVirtualContext(SessionKey, {
    auth: { current: input.auth, initiator: input.initiator },
    sessionId: input.sessionId,
    turn: { id: input.callId, sequence: 0 },
  });
  context.set(CallbackBaseUrlKey, input.callbackBaseUrl.replace(/\/$/, ""));
  context.setVirtualContext(AuthorizationHookKey, `invoke-tool:${input.callId}`);
  return context;
}

async function runCall(input: {
  readonly callId: string;
  readonly definition: HarnessToolDefinition;
  readonly input: JsonObject;
  readonly observer: InvokeToolObserver;
  readonly sandboxOutlivesCall: boolean;
  readonly signal: AbortSignal | undefined;
}): Promise<InvokeToolResult> {
  const { callId, definition, observer } = input;
  const signal = input.signal ?? new AbortController().signal;

  let approval: GateDecision;
  try {
    approval = await decideApproval(definition, {
      abortSignal: signal,
      callId,
      input: input.input,
    });
  } catch (error) {
    observer.failedWith(error);
    return failedFromError(error, definition.name, "approval policy failed");
  }
  if (approval.denied)
    return {
      outcome: "rejected",
      reason: approval.reason ?? `The tool "${definition.name}" was denied by its approval policy.`,
      cause: { policy: "approval" },
    };
  if (approval.clearance === undefined) return { outcome: "rejected", reason: "approval-required" };
  requireClearance(approval.clearance, callId);

  const executeOptions: ToolExecuteOptions = {
    abortSignal: signal,
    messages: [],
    toolCallId: callId,
  };
  await observer.executing(input.input);
  let output: unknown;
  let json: unknown;
  let returned = false;
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
      outcome: "rejected",
      reason: "sign-in-required",
    };
  }
  await observer.executed({ durationMs, output: json, type: "result" });

  try {
    return {
      modelOutput: (await toolCallModelOutput(definition, json, callId, {
        sandboxOutlivesCall: input.sandboxOutlivesCall,
      })) as ToolModelOutput,
      output: json,
      outcome: "completed",
    };
  } catch (error) {
    observer.failedWith(error);
    return failedFromError(error, definition.name, "tool output could not be serialized");
  }
}

async function lastIterated(iterable: AsyncIterable<unknown>): Promise<unknown> {
  let last: unknown;
  for await (const value of iterable) last = value;
  return last;
}

function rejected(reason: string): InvokeToolResult {
  return { reason, outcome: "rejected" };
}

function failed(message: string, code = "TOOL_FAILED"): InvokeToolResult {
  return { outcome: "failed", error: { code, message } };
}

function failedFromError(error: unknown, toolName: string, what: string): InvokeToolResult {
  const errorId = otelContext.with(trace.deleteSpan(otelContext.active()), () =>
    logError(log, `invokeTool ${what}`, error, { toolName }),
  );
  return {
    outcome: "failed",
    error: {
      code: "TOOL_FAILED",
      id: errorId,
      message: `Tool "${toolName}" failed: ${what}. The error is logged with id ${errorId}.`,
    },
  };
}
