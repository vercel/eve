import type { ToolSet } from "ai";

import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  codeModeSessionState,
  diffCodeModeState,
  type CodeModeStateChange,
} from "#execution/code-mode/state.js";
import { contextStorage } from "#context/container.js";
import { withContextScope } from "#context/run-step.js";
import { buildResponseAuthorizationTools } from "#context/build-dynamic-tools.js";
import { buildDynamicSubagentTools } from "#context/dynamic-subagent-lifecycle.js";
import { restoreDynamicToolCallbacks } from "#context/dynamic-tool-lifecycle.js";
import {
  SessionDynamicToolMetadataKey,
  SessionIdKey,
  TurnDynamicToolMetadataKey,
  StepDynamicToolMetadataKey,
} from "#context/keys.js";
import { isCurrentDynamicToolMetadata } from "#context/dynamic-tool-metadata.js";
import { hasUnregisteredDurableDynamicCallbacks } from "#tools/durable-callbacks.js";
import { buildRuntimeIdentity, createNodeHarnessTools } from "#execution/node-step.js";
import { bindDynamicConnections } from "#execution/dynamic-connections.js";
import { getHarnessEmissionState } from "#harness/emission-state.js";
import { requireSessionModelReference } from "#harness/types.js";
import type { WorkflowToolRunRef } from "#execution/tools/workflow/messages.js";
import {
  createSessionStartedEvent,
  createTurnStartedEvent,
  createStepStartedEvent,
} from "#protocol/message.js";
import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { hydrateDurableSession } from "#execution/session.js";
import { createExecutionHistoryView } from "#execution/history-view.js";
import type {
  CodeModeCallResolution,
  CodeModeCallTarget,
  CodeModeToolCatalogEntry,
  CodeModeWorkflowInput,
} from "#execution/code-mode/schema.js";
import {
  AuthorizationHookKey,
  PendingAuthorizationResultKey,
  type AuthorizationSignal,
} from "#harness/authorization.js";
import { readToolInterrupt } from "#harness/tool-interrupts.js";
import {
  codeModeBridgeRequestLimit,
  claimsForCodeMode,
  createDiscoveryTools,
  isCodeModeAgentTool,
} from "#harness/code-mode.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import {
  getApprovedTools,
  resolveApprovalKeyFromTools,
} from "#harness/hitl/approval-input-requests.js";
import { createToolApprovalPrompt } from "#harness/input-extraction.js";
import {
  evaluateToolApproval,
  wrapToolExecute,
  type NativeApprovalStatus,
} from "#harness/tools.js";
import { getWorkflowContinuationSecurity } from "#harness/workflow-continuation-security.js";
import { getResolvedRuntimeAgentNode } from "#runtime/graph.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { isObject } from "#shared/guards.js";
import { parseJsonObject, parseJsonValue, type JsonObject, type JsonValue } from "#shared/json.js";
import { toErrorMessage } from "#shared/errors.js";
import {
  createParkingHostTool,
  createWorkflowSandbox,
  type WorkflowSandboxInterrupt,
} from "#shared/workflow-sandbox.js";
import type { ToolContext, ToolExecuteOptions, ToolInputRequest } from "#tools/definition.js";

/** Interrupt payload raised by every claimed tool the generated program calls. */
export const CODE_MODE_CALL_INTERRUPT_KIND = "eve.code-mode-call";

export interface CodeModeCallInterrupt {
  readonly kind: typeof CODE_MODE_CALL_INTERRUPT_KIND;
  readonly target: Exclude<CodeModeCallTarget, "direct">;
  readonly toolInput: unknown;
  readonly toolName: string;
}

/** One parked nested call, in the order the sandbox recorded it. */
export interface CodeModePendingCall {
  readonly call: CodeModeCallInterrupt;
  readonly interrupt: WorkflowSandboxInterrupt;
  readonly toolCallId: string;
}

export type CodeModeProgramOutcome =
  | { readonly status: "completed"; readonly output: JsonValue }
  | { readonly status: "failed"; readonly error: string }
  | {
      readonly status: "interrupted";
      /** The signed continuation the next `resume` settles. */
      readonly interrupt: WorkflowSandboxInterrupt;
      readonly pending: readonly CodeModePendingCall[];
    };

export type CodeModeToolOutcome = CodeModeCallResolution & {
  readonly stateChanges?: readonly CodeModeStateChange[];
};

/**
 * Starts the generated program, or resumes it once every parked call settled.
 *
 * Every claimed tool is a stub that raises an interrupt, so this step never
 * performs a side effect itself: the sandbox parks at the first unresolved
 * batch of calls and returns a signed continuation. Replaying this step after
 * a crash therefore re-parks at the same calls rather than re-firing anything.
 *
 * A `Promise.all` in the program parks several calls in one continuation. The
 * body settles them concurrently and hands the results back together. Each
 * `continue` re-runs the program from its source with the signed resolution
 * ledger replayed, so a batch of k calls costs k sandbox runs inside this step
 * and the ledger (every prior call's output) travels with each step payload.
 */
export async function runCodeModeProgramStep(input: {
  readonly callId: string;
  readonly program: CodeModeWorkflowInput;
  readonly sessionState: DurableSessionState;
  readonly resume?: {
    readonly interrupt: WorkflowSandboxInterrupt;
    readonly resolutions: readonly CodeModeCallResolution[];
  };
}): Promise<CodeModeProgramOutcome> {
  "use step";

  const security = getWorkflowContinuationSecurity(await readDurableSession(input.sessionState));
  const hostTools: ToolSet = { ...createDiscoveryTools(input.program.toolCatalog) };
  for (const entry of input.program.toolCatalog) {
    if (entry.target !== "direct") hostTools[entry.name] = createCodeModeToolStub(entry);
  }
  const sandbox = await createWorkflowSandbox({
    bridgeRequestLimit: codeModeBridgeRequestLimit(input.program.maxSubagents),
    continuationSecurity: security,
    hostTools,
  });
  const outcome =
    input.resume === undefined
      ? await sandbox.run({ js: input.program.js, toolCallId: input.callId })
      : await sandbox.resume(input.resume);
  if (outcome.status === "completed") {
    return { output: parseJsonValue(outcome.output ?? null), status: "completed" };
  }
  if (outcome.status === "failed") return outcome;
  const pending = outcome.pending.map((interrupt): CodeModePendingCall => ({
    call: readCallInterrupt(interrupt),
    interrupt,
    toolCallId: interrupt.toolCallId,
  }));
  if (pending.length === 0) {
    throw new Error("code_mode continuation contains no pending call.");
  }
  return { interrupt: outcome.interrupt, pending, status: "interrupted" };
}

export interface CodeModeToolCall {
  readonly event: Pick<WorkflowToolRunRef, "sequence" | "stepIndex" | "turnId">;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly toolCallId: string;
  readonly toolInput: unknown;
  readonly toolName: string;
}

/**
 * Executes one ordinary claimed tool with the turn's context rebuilt from its
 * serialized form. The sandbox and connections resolve through the same
 * providers a turn step uses, so `bash`, `read_file`, connection tools, and
 * authored tools all run unchanged; the parent materialized the sandbox before
 * dispatching, so this step only reconnects to it.
 *
 * Authorization rides the workflow-tool step mechanism: passing the run's
 * `ctx` routes the call through `workflowToolStep`, whose twin seeds the hook
 * token and pending results on the ambient context, publishes challenges to
 * the owner, and retries this step once the callbacks land. This step only
 * mirrors those keys into the hydrated turn context and returns the tool's
 * `AuthorizationSignal` unchanged.
 */
export async function executeCodeModeToolStep(
  _ctx: Pick<ToolContext, "abortSignal" | "callId" | "toolName">,
  input: CodeModeToolCall,
): Promise<CodeModeToolOutcome | AuthorizationSignal> {
  "use step";

  const ambient = contextStorage.getStore();
  const { ctx, harnessTools, session, rehydrateConnections } = await hydrateTurnTools(input);
  const hookToken = ambient?.get(AuthorizationHookKey);
  if (hookToken !== undefined) ctx.set(AuthorizationHookKey, hookToken);
  ctx.set(PendingAuthorizationResultKey, ambient?.get(PendingAuthorizationResultKey) ?? []);
  const definition = harnessTools.get(input.toolName);
  if (
    definition === undefined ||
    isCodeModeAgentTool(definition) ||
    !claimsForCodeMode(input.toolName, harnessTools)
  ) {
    return {
      status: "failed",
      error: `Tool "${input.toolName}" is not available to code_mode in this session.`,
    };
  }
  // The body runs authored workflow tools inline; their `execute` is a
  // workflow function, not something this step can call directly.
  if (definition.workflowId !== undefined) {
    return {
      status: "failed",
      error: `Tool "${input.toolName}" is a workflow tool and cannot run as a code_mode tool step.`,
    };
  }
  const execute = wrapToolExecute(definition);
  if (execute === undefined) {
    return { status: "failed", error: `Tool "${input.toolName}" has no executor.` };
  }
  // The turn's history as of dispatch: the same view a direct call would see.
  const options: ToolExecuteOptions = {
    messages: createExecutionHistoryView(session).initial.messages,
    toolCallId: input.toolCallId,
  } as ToolExecuteOptions;
  const toolContext = () => {
    const serialized = serializeContext(ctx);
    delete serialized[AuthorizationHookKey.name];
    delete serialized[PendingAuthorizationResultKey.name];
    return serialized;
  };
  const before = structuredClone({
    serializedContext: toolContext(),
    ...codeModeSessionState(session),
  });
  let updatedSession = session;
  let outcome: CodeModeToolOutcome;
  try {
    const scoped = await withContextScope(ctx, session, async (enriched) => {
      await rehydrateConnections();
      const result = await execute(input.toolInput, options);
      const output = isAsyncIterable(result) ? await lastOf(result) : result;
      return { result: output, session: enriched };
    });
    // The tool consumed results from the hydrated context; the twin reads the
    // remainder from the ambient one to report which attempts completed.
    ambient?.setVirtualContext(
      PendingAuthorizationResultKey,
      ctx.get(PendingAuthorizationResultKey) ?? [],
    );
    updatedSession = scoped.session;
    const authorization = readToolInterrupt(ctx, input.toolCallId);
    // State captured before a sign-in is re-derived when the twin retries.
    if (authorization !== undefined) return authorization;
    outcome = { status: "completed", output: parseJsonValue(scoped.result ?? null) };
  } catch (error) {
    outcome = { status: "failed", error: toErrorMessage(error) };
  }
  const stateChanges = diffCodeModeState(before, {
    serializedContext: toolContext(),
    ...codeModeSessionState(updatedSession),
  });
  return stateChanges.length === 0 ? outcome : { ...outcome, stateChanges };
}

export type CodeModeApprovalDecision =
  | { readonly status: "not-required" }
  | { readonly status: "denied"; readonly reason?: string }
  | { readonly status: "failed"; readonly error: string }
  | {
      readonly status: "required";
      /** Key `once()` remembers on approval: `approvalKey(input)` when the tool defines one, else the tool name. */
      readonly approvalKey: string;
      /**
       * The nested call as the approval card shows it. `callId` is the
       * sandbox's nested id (`<code_mode callId>:tool-N`): unique per call, so
       * the card renders as its own nested tool call instead of rewriting the
       * `code_mode` card, and never a turn action the owner could dispatch.
       */
      readonly action: {
        readonly callId: string;
        readonly input: JsonObject;
        readonly toolName: string;
      };
      readonly request: ToolInputRequest;
    };

/**
 * Evaluates a claimed tool's approval policy exactly as a direct call would:
 * with the turn's session context and the keys the person already approved,
 * including those granted earlier in this program. The body asks the person
 * only when the policy answers `user-approval`; policy evaluation needs the
 * harness, so it runs here rather than in the workflow body.
 */
export async function evaluateCodeModeApprovalStep(
  input: CodeModeToolCall,
): Promise<CodeModeApprovalDecision> {
  "use step";

  const { ctx, harnessTools, session } = await hydrateTurnTools(input);
  const definition = harnessTools.get(input.toolName);
  if (
    definition === undefined ||
    isCodeModeAgentTool(definition) ||
    !claimsForCodeMode(input.toolName, harnessTools)
  ) {
    return {
      status: "failed",
      error: `Tool "${input.toolName}" is not available to code_mode in this session.`,
    };
  }
  if (definition.approval === undefined) return { status: "not-required" };
  const toolInput = readApprovalToolInput(input.toolInput);
  const approvedTools = getApprovedTools(session, resolveApprovalKeyFromTools(harnessTools));
  let status: NativeApprovalStatus;
  try {
    const scoped = await withContextScope(ctx, session, async (enriched) => ({
      result: await evaluateToolApproval(definition, {
        approvedTools,
        callId: input.toolCallId,
        toolInput: input.toolInput,
      }),
      session: enriched,
    }));
    status = scoped.result;
  } catch (error) {
    return { status: "failed", error: toErrorMessage(error) };
  }
  const kind = typeof status === "object" ? status.type : status;
  switch (kind) {
    case "user-approval":
      return {
        status: "required",
        approvalKey: definition.approvalKey?.(toolInput) ?? definition.name,
        action: { callId: input.toolCallId, input: toolInput, toolName: input.toolName },
        request: createToolApprovalPrompt(input.toolName),
      };
    case "denied": {
      const reason = typeof status === "object" ? status.reason : undefined;
      return reason === undefined ? { status: "denied" } : { status: "denied", reason };
    }
    default:
      return { status: "not-required" };
  }
}

export function createCodeModeToolStub(entry: CodeModeToolCatalogEntry): ToolSet[string] {
  return createParkingHostTool({
    description: entry.description,
    inputSchema: entry.inputSchema,
    outputSchema: entry.outputSchema ?? undefined,
    interrupt: (toolInput) =>
      ({
        kind: CODE_MODE_CALL_INTERRUPT_KIND,
        target: entry.target === "direct" ? "tool" : entry.target,
        toolInput,
        toolName: entry.name,
      }) satisfies CodeModeCallInterrupt,
  });
}

async function hydrateTurnTools(input: {
  readonly event: Pick<WorkflowToolRunRef, "sequence" | "stepIndex" | "turnId">;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}) {
  const durable = await readDurableSession(input.sessionState);
  const ctx = await deserializeContext(input.serializedContext);
  const bundle = ctx.require(BundleKey);
  const effective = resolveEffectiveAgentRuntime(bundle, ctx);
  const baseNode = getResolvedRuntimeAgentNode(bundle.graph, bundle.nodeId);
  const node = { ...baseNode, turnAgent: effective.turnAgent };
  const session = hydrateDurableSession({
    compactionOverrides: { thresholdPercent: effective.thresholdPercent },
    durable,
    turnAgent: effective.turnAgent,
  });
  const emission = getHarnessEmissionState(session.state);
  const runtime = buildRuntimeIdentity(node);
  const connections = bindDynamicConnections(ctx, bundle.resolvedAgent);
  const rehydrateConnections = () => connections.rehydrate(emission, runtime, false);
  const sessionId = ctx.require(SessionIdKey);
  const scopedMetadata = [
    ["session", SessionDynamicToolMetadataKey],
    ["turn", TurnDynamicToolMetadataKey],
    ["step", StepDynamicToolMetadataKey],
  ] as const;
  const needsRestore = scopedMetadata.some(([scope, key]) =>
    (ctx.get(key) ?? []).some(
      (entry) =>
        !isCurrentDynamicToolMetadata(entry) ||
        hasUnregisteredDurableDynamicCallbacks([entry], { sessionId, scope }),
    ),
  );
  if (needsRestore) {
    await withContextScope(ctx, session, async (enriched) => {
      await rehydrateConnections();
      await restoreDynamicToolCallbacks({
        ctx,
        resolvers: bundle.resolvedAgent.dynamicToolResolvers ?? [],
        events: [
          createSessionStartedEvent({ runtime }),
          createTurnStartedEvent(input.event),
          createStepStartedEvent({
            ...input.event,
            modelId: requireSessionModelReference(session).id,
          }),
        ],
        messages: createExecutionHistoryView(session).initial.messages,
      });
      return { result: undefined, session: enriched };
    });
  }
  const harnessTools = new Map<string, HarnessToolDefinition>(createNodeHarnessTools({ node }));
  for (const dynamicSubagent of buildDynamicSubagentTools(ctx)) {
    harnessTools.set(dynamicSubagent.name, dynamicSubagent);
  }
  return {
    ctx,
    harnessTools: buildResponseAuthorizationTools({ authoredTools: harnessTools, context: ctx }),
    session,
    rehydrateConnections,
  };
}

// Approval cards and `approvalKey(input)` expect the object the model would
// have sent; a program passing anything else still gets its schema error from
// the tool itself once approved.
function readApprovalToolInput(value: unknown): JsonObject {
  if (!isObject(value)) return {};
  try {
    return parseJsonObject(value);
  } catch {
    return {};
  }
}

function readCallInterrupt(interrupt: WorkflowSandboxInterrupt): CodeModeCallInterrupt {
  const payload = interrupt.payload as Partial<CodeModeCallInterrupt>;
  if (
    payload.kind !== CODE_MODE_CALL_INTERRUPT_KIND ||
    (payload.target !== "agent" && payload.target !== "tool" && payload.target !== "workflow") ||
    typeof payload.toolName !== "string"
  ) {
    throw new Error(`Unsupported code_mode interrupt kind "${String(payload.kind)}".`);
  }
  return {
    kind: CODE_MODE_CALL_INTERRUPT_KIND,
    target: payload.target,
    toolInput: payload.toolInput,
    toolName: payload.toolName,
  };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}

async function lastOf(iterable: AsyncIterable<unknown>): Promise<unknown> {
  let last: unknown;
  for await (const value of iterable) last = value;
  return last;
}
