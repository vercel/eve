import type { Context, SpanContext } from "@opentelemetry/api";
import type {
  InstrumentationActionStartedEvent,
  InstrumentationToolCallStartedEvent,
  InstrumentationToolCallTerminalEvent,
} from "#instrumentation/lifecycle.js";
import { actionIdempotencyKey } from "#instrumentation/lifecycle.js";
import type { AgentActionContext } from "#tracing/eve/agent-action-instrumentation.js";
import { resolveConversationId } from "#shared/conversation-identity.js";
import type { DurableTraceRuntime } from "#tracing/lib/index.js";
import {
  readPendingToolSnapshot,
  writePendingToolSnapshot,
} from "#tracing/eve/agent-trace-context-store.js";

export function createAgentToolInstrumentation(input: {
  readonly lifecycle: DurableTraceRuntime;
  readonly actionContextFor: (
    sessionId: string,
    turnId: string,
    callId: string,
  ) => Promise<AgentActionContext | undefined>;
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
  readonly resolveFallback: (
    event: InstrumentationToolCallStartedEvent,
  ) => { context: Context; spanContext: SpanContext } | undefined;
}) {
  const tools = new Map<
    string,
    {
      actionKey: string;
      group: string;
      handle: Awaited<ReturnType<DurableTraceRuntime["pendingTool"]>>;
    }
  >();
  const completed = new Set<string>();
  function forget(key: string) {
    tools.delete(key);
    completed.add(key);
    if (completed.size > 10000) completed.delete(completed.values().next().value!);
  }
  async function restore() {
    const snapshot = readPendingToolSnapshot();
    if (!Array.isArray(snapshot) || snapshot.length > 10000) return;
    for (const tool of snapshot) {
      if (
        tool === null ||
        typeof tool !== "object" ||
        typeof tool.key !== "string" ||
        typeof tool.group !== "string" ||
        typeof tool.actionKey !== "string"
      )
        continue;
      if (tools.has(tool.key) || completed.has(tool.key)) continue;
      const handle = await input.lifecycle.resumeTool(tool.state);
      if (handle !== undefined)
        tools.set(tool.key, { actionKey: tool.actionKey, group: tool.group, handle });
    }
  }
  function persist() {
    writePendingToolSnapshot(
      [...tools].map(([key, tool]) => ({
        key,
        actionKey: tool.actionKey,
        group: tool.group,
        state: tool.handle.snapshot(),
      })),
    );
  }
  async function actionAvailable(event: {
    scope: InstrumentationToolCallStartedEvent["scope"];
    callId: string;
  }) {
    await restore();
    const parent = await input.actionContextFor(
      event.scope.sessionId,
      event.scope.turnId,
      event.callId,
    );
    if (parent !== undefined)
      for (const [key, tool] of tools)
        if (
          tool.actionKey ===
          actionIdempotencyKey(event.scope.sessionId, event.scope.turnId, event.callId)
        ) {
          await tool.handle.attach(parent.spanContext, parent.context);
          if (tool.handle.finished) {
            forget(key);
          }
        }
    persist();
  }
  async function onStarted(event: InstrumentationToolCallStartedEvent) {
    await restore();
    const fallback =
      input.resolveFallback(event) ??
      (await input.actionContextFor(event.scope.sessionId, event.scope.turnId, event.callId));
    if (fallback === undefined) return;
    if (
      tools.has(event.idempotencyKey) ||
      completed.has(event.idempotencyKey) ||
      tools.size >= 10000
    )
      return;
    const handle = await input.lifecycle.pendingTool({
      identity: {
        conversationId: resolveConversationId(event.scope.rootSessionId ?? event.scope.sessionId),
        runId: event.scope.sessionId,
        turnId: event.scope.turnId,
        agentName: event.scope.functionId,
        framework: { name: "eve" },
      },
      key: event.idempotencyKey,
      callId: event.callId,
      name: event.toolName,
      arguments: input.recordInputs ? event.input : undefined,
      parent: fallback.spanContext,
      capture: {
        emit: (fallback.spanContext.traceFlags & 1) !== 0,
        recordInputs: input.recordInputs,
        recordOutputs: input.recordOutputs,
      },
      context: fallback.context,
    });
    tools.set(event.idempotencyKey, {
      handle,
      group: event.scope.attemptId,
      actionKey: actionIdempotencyKey(event.scope.sessionId, event.scope.turnId, event.callId),
    });
    await actionAvailable(event);
  }
  async function onTerminal(event: InstrumentationToolCallTerminalEvent) {
    await restore();
    const handle = tools.get(event.idempotencyKey)?.handle;
    await handle?.complete(
      event.type === "tool.call.failed" || event.output.type === "error"
        ? {
            outcome: "failed",
            failed: true,
            errorCode: "Error",
            error:
              event.type === "tool.call.failed"
                ? event.error
                : event.output.type === "error"
                  ? event.output.error
                  : undefined,
          }
        : { outcome: "completed", output: input.recordOutputs ? event.output.output : undefined },
    );
    if (handle?.finished) {
      forget(event.idempotencyKey);
    }
    persist();
  }
  return {
    actionStarted: (event: InstrumentationActionStartedEvent) => actionAvailable(event),
    operationFor: (_attemptId: string, key: string) => tools.get(key)?.handle,
    drain: async (attemptId: string, failure?: { error: unknown }) => {
      await restore();
      for (const [key, tool] of tools)
        if (tool.group === attemptId) {
          await tool.handle.drain({ failed: failure !== undefined, error: failure?.error });
          forget(key);
        }
      persist();
    },
    events: {
      "tool.call.started": onStarted,
      "tool.call.completed": onTerminal,
      "tool.call.failed": onTerminal,
    },
  };
}
