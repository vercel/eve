import { readToolInterrupt } from "#harness/tool-interrupts.js";
import type { AuthorizationSignal } from "#harness/authorization.js";
import { getStepMetadata } from "#compiled/@workflow/core/index.js";
import { deserializeContext } from "#context/serialize.js";
import { contextStorage } from "#context/container.js";
import { withContextScope } from "#context/run-step.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { getResolvedRuntimeAgentNode } from "#runtime/graph.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { connectionToolName } from "#connections/ownership.js";
import { buildStepCatalog, type StepCatalog } from "#execution/catalog/step-catalog.js";
import { listToolMetadata } from "#execution/catalog/connection-auth.js";
import { bindDynamicConnections } from "#execution/dynamic-connections.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { createNodeHarnessTools, buildRuntimeIdentity } from "#execution/node-step.js";
import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { hydrateDurableSession } from "#execution/session.js";

import { buildToolApproval, recheckApprovedCall, wrapToolExecute } from "#harness/tools.js";
import { checkToolCallInput } from "#harness/tool-call-io.js";
import { runEntryCall } from "#harness/execute-call.js";
import { AuthorizationHookKey, PendingAuthorizationResultKey } from "#harness/authorization.js";
import { sessionView } from "#harness/session-machine/commit.js";
import { storedProjection, turnPosition } from "#harness/session-machine/view.js";
import { grantedApprovalKeys } from "#harness/hitl/index.js";
import { toErrorMessage } from "#shared/errors.js";
import { parseJsonValue, type JsonObject } from "#shared/json.js";
import type { WorkflowStepToolContext } from "#tools/workflow-definition.js";
import type {
  ProgramCall,
  ProgramCallResult,
  ProgramLimits,
  ProgramStart,
  ProgramResume,
  ProgramLanguage,
  ProgramStep,
} from "./runtime.js";
import { getProgramRuntime } from "./registry.js";

export interface ProgramContext {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

export async function initializeProgramStep(
  context: ProgramContext,
  timeoutMs: number,
): Promise<{ limits: ProgramLimits; toolNames: string[] }> {
  "use step";
  return withCatalog(context, async (catalog, ctx) => {
    const names = new Set(catalog.entries.keys());
    const registry = ctx.get(ConnectionRegistryKey);
    for (const connection of catalog.connections) {
      if (registry === undefined) continue;
      try {
        const tools = await listToolMetadata(
          connection,
          registry.getClient(connection.connectionName),
        );
        for (const tool of tools)
          names.add(connectionToolName(connection.connectionName, tool.name));
      } catch {
        /* Tools become available after their normal catalog sign-in. */
      }
    }
    names.delete("eve__execute");
    return {
      toolNames: [...names],
      limits: {
        deadlineAt: Date.now() + timeoutMs,
        memoryBytes: 64 * 1024 * 1024,
        maxInFlightCalls: 32,
        maxTotalCalls: 256,
      },
    };
  });
}

export async function runProgramStep(
  language: ProgramLanguage,
  input: ProgramStart | ProgramResume,
): Promise<ProgramStep> {
  "use step";
  const started = Date.now();
  try {
    const runtime = getProgramRuntime(language);
    const outcome = "state" in input ? await runtime.resume(input) : await runtime.start(input);
    return {
      ...outcome,
      timing: outcome.timing ?? { startupMs: 0, runMs: Math.max(0, Date.now() - started) },
    };
  } catch (error) {
    return {
      status: "failed",
      error: toErrorMessage(error),
      errorClass: "runtime",
      logs: [],
      timing: { startupMs: 0, runMs: Math.max(0, Date.now() - started) },
    };
  }
}

export type ProgramApproval =
  | { readonly status: "approved"; readonly key: string; readonly input: JsonObject }
  | { readonly status: "required"; readonly key: string; readonly input: JsonObject }
  | { readonly status: "denied"; readonly error: string };

export async function approveProgramCallStep(
  context: ProgramContext,
  call: ProgramCall,
  callId: string,
  approvedKeys: readonly string[],
): Promise<ProgramApproval> {
  "use step";
  return withCatalog(context, async (catalog, _ctx, session) => {
    const resolved = resolveCall(catalog, call);
    const checked = await checkToolCallInput(resolved.definition, call.input, callId);
    if (checked.kind === "threw") throw checked.error;
    if (checked.kind === "invalid")
      return {
        status: "denied",
        error: `Invalid input for ${call.tool}: ${JSON.stringify(checked.issues)}`,
      };
    const keys = new Set([
      ...approvedKeys,
      ...grantedApprovalKeys(
        sessionView(storedProjection(session.state), session.state),
        (request) => catalog.get(request.action.toolName)?.approvalKey?.(request.action.input),
      ),
    ]);
    const key = resolved.definition.approvalKey?.(checked.value) ?? call.tool;
    const policy = buildToolApproval({ approvedTools: keys, resolve: () => resolved as never });
    const approval =
      typeof policy === "function"
        ? await policy({
            toolCall: {
              type: "tool-call",
              toolCallId: callId,
              toolName: call.tool,
              input: checked.value,
            },
            messages: [],
          } as never)
        : undefined;
    const status = typeof approval === "object" && approval !== null ? approval.type : approval;
    if (status === "denied")
      return { status: "denied", error: `Approval policy denied ${call.tool}.` };
    return {
      status: status === "user-approval" ? "required" : "approved",
      key,
      input: checked.value,
    };
  });
}

/** A durable record before the side-effecting step. Its result is replayed verbatim. */
export async function recordProgramCallStartedStep(
  callId: string,
): Promise<{ callId: string; status: "started" }> {
  "use step";
  return { callId, status: "started" };
}

/** Each invocation has its own durable result; an interrupted attempt is never retried. */
export async function dispatchProgramCallStep(
  ctx: WorkflowStepToolContext,
  context: ProgramContext,
  call: ProgramCall,
  marker: { callId: string; status: "started" },
  approvedKeys: readonly string[],
): Promise<ProgramCallResult | AuthorizationSignal> {
  "use step";
  if (getStepMetadata().attempt > 1)
    return {
      index: call.index,
      status: "unknown",
      error:
        "A tool call started but its result was not recorded; the side effect may or may not have happened.",
    };
  try {
    return await withCatalog(context, async (catalog, hydrated) => {
      const resolved = resolveCall(catalog, call);
      const denied = await recheckApprovedCall(resolved.definition, {
        callId: marker.callId,
        input: call.input,
        approvedTools: new Set(approvedKeys),
        abortSignal: ctx.abortSignal,
      });
      if (denied.denied)
        return {
          index: call.index,
          status: "failed",
          error: denied.reason ?? `Approval policy denied ${call.tool}.`,
        };
      if (resolved.definition.workflowId !== undefined)
        throw new Error(
          `Workflow-backed tool "${call.tool}" must be invoked with workflow() or directly; nested code-mode workflow tools are not available yet.`,
        );
      const execute = wrapToolExecute({
        ...resolved.definition,
        execute: (_input, options) => runEntryCall(resolved, options),
      });
      if (execute === undefined) throw new Error(`Tool "${call.tool}" cannot run.`);
      let output: unknown = execute(call.input, {
        toolCallId: marker.callId,
        messages: [],
        abortSignal: ctx.abortSignal,
      });
      if (typeof output === "object" && output !== null && Symbol.asyncIterator in output) {
        let last: unknown;
        for await (const part of output as AsyncIterable<unknown>) last = part;
        output = last;
      } else output = await output;
      const interrupt = readToolInterrupt(hydrated, marker.callId);
      if (interrupt !== undefined) return interrupt;
      return { index: call.index, status: "completed", output: parseJsonValue(output ?? null) };
    });
  } catch (error) {
    ctx.abortSignal.throwIfAborted();
    return { index: call.index, status: "failed", error: toErrorMessage(error) };
  }
}

function resolveCall(catalog: StepCatalog, call: ProgramCall) {
  if (call.tool === "eve__execute") throw new Error("Recursive code-mode calls are not allowed.");
  const definition = catalog.get(call.tool);
  const modelCall = {
    toolName: definition?.deferred === true || definition === undefined ? "eve__tool" : call.tool,
    input:
      definition?.deferred === true || definition === undefined
        ? { name: call.tool, input: call.input }
        : call.input,
  };
  const resolved = catalog.resolve(modelCall);
  if (resolved === undefined)
    throw new Error(`Tool "${call.tool}" is not available in this session.`);
  return resolved;
}

async function withCatalog<T>(
  input: ProgramContext,
  run: (
    catalog: StepCatalog,
    ctx: Awaited<ReturnType<typeof deserializeContext>>,
    session: ReturnType<typeof hydrateDurableSession>,
  ) => Promise<T>,
): Promise<T> {
  const ambient = contextStorage.getStore();
  const ctx = await deserializeContext(input.serializedContext);
  const bundle = ctx.require(BundleKey);
  const effective = resolveEffectiveAgentRuntime(bundle, ctx);
  const node = {
    ...getResolvedRuntimeAgentNode(bundle.graph, bundle.nodeId),
    turnAgent: effective.turnAgent,
  };
  const session = hydrateDurableSession({
    durable: readDurableSession(input.sessionState),
    turnAgent: effective.turnAgent,
    compactionOverrides: { thresholdPercent: effective.thresholdPercent },
  });
  const connections = bindDynamicConnections(ctx, bundle.resolvedAgent);
  const scoped = await withContextScope(ctx, session, async (enriched) => {
    await connections.rehydrate(
      turnPosition(storedProjection(enriched.state)),
      buildRuntimeIdentity(node),
      {
        sequence: turnPosition(storedProjection(enriched.state)).sequence,
        turnId: turnPosition(storedProjection(enriched.state)).turnId,
      },
    );
    const hook = ambient?.get(AuthorizationHookKey);
    if (hook !== undefined) ctx.setVirtualContext(AuthorizationHookKey, hook);
    ctx.setVirtualContext(
      PendingAuthorizationResultKey,
      ambient?.get(PendingAuthorizationResultKey) ?? [],
    );
    const catalog = buildStepCatalog({
      agentTools: createNodeHarnessTools({ node }),
      ctx,
      session: enriched,
      endsTurn: false,
    });
    const result = await run(catalog, ctx, enriched);
    ambient?.setVirtualContext(
      PendingAuthorizationResultKey,
      ctx.get(PendingAuthorizationResultKey) ?? [],
    );
    return { result, session: enriched };
  });
  return scoped.result;
}
