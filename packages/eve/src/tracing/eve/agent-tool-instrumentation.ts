import { ROOT_CONTEXT, type Context, type SpanContext, trace } from "@opentelemetry/api";

import type {
  InstrumentationAttemptScope,
  InstrumentationExecutionOperation,
  InstrumentationToolCallStartedEvent,
  InstrumentationToolCallTerminalEvent,
} from "#instrumentation/lifecycle.js";
import { actionIdempotencyKey } from "#instrumentation/lifecycle.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";
import type {
  AgentActionTraceState,
  AgentTraceStateStore,
} from "#tracing/eve/agent-trace-state.js";
import { withChannelAudience } from "#tracing/eve/channel-audience-context.js";
import { eveTurnIdentity } from "#tracing/eve/operation-input.js";
import type {
  AgentTracing,
  AttemptOperation,
  CaptureDecision,
  ToolInput,
  ToolOperation,
} from "#tracing/lib/index.js";

export interface AgentToolContext {
  readonly context: Context;
  readonly spanContext: SpanContext;
}

type ToolExecution = Extract<InstrumentationExecutionOperation, { type: "tool.call" }>;

/** What the SDK reported about one tool run, kept until the dispatch or the step settles it. */
interface Execution {
  readonly attemptId: string;
  readonly idempotencyKey: string;
  readonly tool: ToolOperation;
  terminal?: {
    readonly completedAtMs: number;
    readonly durationMs?: number;
    readonly failed: boolean;
    readonly error?: unknown;
    readonly output?: unknown;
  };
}

const OPEN_EXECUTIONS = 10000;

/** Finds an open tool call in its turn's trace tree, in this or a later process. */
export async function resumeTool(
  tracing: AgentTracing,
  state: AgentActionTraceState,
): Promise<ToolOperation | undefined> {
  const turn = await tracing.resume({
    identity: eveTurnIdentity(state),
    context: withChannelAudience(ROOT_CONTEXT, state.channelAudience),
  });
  return turn?.findTool(state.callId);
}

/**
 * One `execute_tool` span per call. eve's tool loop reports the durable
 * dispatch through `tool.call.*` events; the SDK reports the run through the
 * execution context. Both name the same call ID, so they share one span. A run
 * without a dispatch closes under its step when the step ends.
 */
export function createAgentToolInstrumentation(input: {
  readonly tracing: AgentTracing;
  readonly attemptFor: (
    scope: InstrumentationAttemptScope,
  ) => Promise<AttemptOperation | undefined>;
  readonly stepFor: (scope: InstrumentationAttemptScope) => AttemptOperation | undefined;
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
  readonly stateStore: AgentTraceStateStore;
}) {
  const executions = new Map<string, Execution>();
  const callKey = (scope: { sessionId: string; turnId: string }, callId: string) =>
    actionIdempotencyKey(scope.sessionId, scope.turnId, callId);

  async function stateFor(sessionId: string, turnId: string, callId: string) {
    const direct = await input.stateStore.get(
      "action",
      actionIdempotencyKey(sessionId, turnId, callId),
    );
    if (direct !== undefined) return direct;
    return (await input.stateStore.entries("action")).find(
      ([, state]) => state.sessionId === sessionId && state.callId === callId,
    )?.[1];
  }

  /** Reports the call again through its parent, so a later report refines the same span. */
  async function reenter(state: AgentActionTraceState, report: ToolInput) {
    const turn = await input.tracing.resume({
      identity: eveTurnIdentity(state),
      context: withChannelAudience(ROOT_CONTEXT, state.channelAudience),
    });
    if (turn?.findTool(state.callId) === undefined) return undefined;
    const parent =
      state.parentCallId === undefined
        ? turn.findAttempt({ stepIndex: state.stepIndex, attempt: state.attemptIndex })
        : turn.findTool(state.parentCallId);
    return parent === undefined ? turn.findTool(state.callId) : parent.tool(report);
  }

  /** A dispatched call takes the run's timing and failure; its own terminal ends the span. */
  async function settleExecution(execution: Execution, dispatched: AgentActionTraceState) {
    const terminal = execution.terminal;
    if (terminal === undefined) return;
    executions.delete(execution.idempotencyKey);
    if (terminal.failed) execution.tool.recordError(terminal.error);
    else if (terminal.durationMs !== undefined)
      execution.tool.attributes({ "gen_ai.execute_tool.duration": terminal.durationMs / 1000 });
    await input.stateStore.set("action", execution.idempotencyKey, {
      ...dispatched,
      toolEndTimeMs: terminal.completedAtMs,
    });
  }

  async function onDispatchStarted(event: InstrumentationToolCallStartedEvent): Promise<void> {
    let state = await input.stateStore.get("action", event.idempotencyKey);
    if (state === undefined) {
      const parentState =
        event.parentCallId === undefined
          ? undefined
          : await stateFor(event.scope.sessionId, event.scope.turnId, event.parentCallId);
      const parent =
        parentState === undefined
          ? await input.attemptFor(event.scope)
          : await resumeTool(input.tracing, parentState);
      if (parent === undefined) return;
      const tool = await parent.tool({
        callId: event.callId,
        name: event.toolName,
        kind: event.kind ?? "tool-call",
        arguments: input.recordInputs ? event.input : undefined,
        startTimeMs: event.startedAtMs,
      });
      tool.attributes({ "agent.tool.is_framework": event.frameworkTool === true });
      state = {
        attemptId: event.scope.attemptId,
        attemptIndex: event.scope.attemptIndex,
        callId: event.callId,
        channelAudience: normalizeChannelAudience(event.scope.channelAudience),
        context: { ...tool.reference, isRemote: false },
        parentCallId: parentState === undefined ? undefined : event.parentCallId,
        rootSessionId: event.scope.rootSessionId,
        sessionId: event.scope.sessionId,
        stepIndex: event.scope.stepIndex,
        turnId: event.scope.turnId,
      };
      await input.stateStore.set("action", event.idempotencyKey, state);
      const execution = executions.get(event.idempotencyKey);
      if (execution !== undefined) await settleExecution(execution, state);
    }
    if (event.isWorkflowTool === true) {
      await input.stateStore.set("anchor", event.idempotencyKey, state);
    }
  }

  async function onDispatchTerminal(event: InstrumentationToolCallTerminalEvent): Promise<void> {
    const state = await input.stateStore.get("action", event.idempotencyKey);
    if (state === undefined) return;
    try {
      const tool = await resumeTool(input.tracing, state);
      const error =
        event.type === "tool.call.failed"
          ? event.error
          : event.output.type === "error"
            ? event.output.error
            : undefined;
      await tool?.complete({
        outcome: event.outcome ?? (event.type === "tool.call.failed" ? "failed" : "completed"),
        failed: event.type === "tool.call.failed" || event.output.type === "error",
        errorType: event.type === "tool.call.failed" ? event.errorCode : undefined,
        error,
        output:
          input.recordOutputs &&
          event.type === "tool.call.completed" &&
          event.output.type === "result"
            ? event.output.output
            : undefined,
        usage: event.usage,
        endTimeMs: event.acceptedAtMs ?? state.toolEndTimeMs,
      });
    } finally {
      await input.stateStore.delete("action", event.idempotencyKey);
    }
  }

  async function executionFor(
    operation: ToolExecution & { callId: string; toolName: string },
    ceiling: CaptureDecision,
  ) {
    const key = callKey(operation.scope, operation.callId);
    const known = executions.get(key);
    if (known !== undefined) return known;
    const state = await stateFor(
      operation.scope.sessionId,
      operation.scope.turnId,
      operation.callId,
    );
    const report: ToolInput = {
      callId: operation.callId,
      name: operation.toolName,
      arguments: input.recordInputs && ceiling.recordInputs ? operation.input : undefined,
      startTimeMs: operation.startedAtMs,
    };
    const tool =
      state === undefined
        ? await input.stepFor(operation.scope)?.tool(report)
        : await reenter(state, report);
    if (tool === undefined || executions.size >= OPEN_EXECUTIONS) return undefined;
    const execution: Execution = {
      attemptId: operation.scope.attemptId,
      idempotencyKey: key,
      tool,
    };
    executions.set(key, execution);
    return execution;
  }

  async function finishExecution(execution: Execution, terminal: Execution["terminal"]) {
    execution.terminal = terminal;
    const key = execution.idempotencyKey;
    const dispatched = await input.stateStore.get("action", key);
    if (dispatched !== undefined) await settleExecution(execution, dispatched);
  }

  return {
    stateFor,
    async contextFor(sessionId: string, turnId: string, callId: string) {
      const state = await stateFor(sessionId, turnId, callId);
      return state === undefined ? undefined : toolContext(state);
    },
    async deleteForSession(sessionId: string) {
      for (const kind of ["action", "anchor"] as const)
        for (const [key, state] of await input.stateStore.entries(kind))
          if (state.sessionId === sessionId) await input.stateStore.delete(kind, key);
    },
    // A failed attempt closes its calls in the trace tree; only the locators remain.
    async forgetAttempt(scope: InstrumentationAttemptScope) {
      for (const [key, state] of await input.stateStore.entries("action"))
        if (state.attemptId === scope.attemptId) await input.stateStore.delete("action", key);
    },
    /** Closes SDK runs that no dispatch claimed before their step ended. */
    async drain(attemptId: string, failure?: { readonly error: unknown }) {
      for (const [key, execution] of executions) {
        if (execution.attemptId !== attemptId) continue;
        executions.delete(key);
        if ((await input.stateStore.get("action", key)) !== undefined) continue;
        const terminal = execution.terminal;
        if (failure !== undefined) {
          await execution.tool.fail(failure.error);
          continue;
        }
        if (terminal?.durationMs !== undefined && !terminal.failed)
          execution.tool.attributes({ "gen_ai.execute_tool.duration": terminal.durationMs / 1000 });
        await execution.tool.complete({
          failed: terminal?.failed,
          error: terminal?.error,
          output: terminal?.output,
          endTimeMs: terminal?.completedAtMs,
        });
      }
    },
    /** Runs the SDK's tool call inside its span, or calls `fallback` when it has none. */
    async runInContext<T>(
      operation: ToolExecution,
      execute: () => PromiseLike<T>,
      ceiling: CaptureDecision,
      fallback: () => Promise<T>,
    ): Promise<T> {
      if (operation.callId === undefined || operation.toolName === undefined) return fallback();
      const execution = await executionFor(
        { ...operation, callId: operation.callId, toolName: operation.toolName },
        ceiling,
      );
      if (execution === undefined || execution.tool.finished) return fallback();
      execution.tool.attributes({ "agent.tool.is_framework": operation.frameworkTool === true });
      const startedAtMs = operation.startedAtMs ?? Date.now();
      try {
        const result = await execution.tool.run(execute, ceiling);
        const completedAtMs = operation.completedAtMs ?? Date.now();
        await finishExecution(execution, {
          completedAtMs,
          durationMs: completedAtMs - startedAtMs,
          failed: operation.failed === true,
          output: input.recordOutputs && ceiling.recordOutputs ? result : undefined,
        });
        return result;
      } catch (error) {
        await finishExecution(execution, {
          completedAtMs: Date.now(),
          failed: true,
          error: ceiling.recordOutputs ? error : undefined,
        });
        throw error;
      }
    },
    events: {
      "tool.call.completed": onDispatchTerminal,
      "tool.call.failed": onDispatchTerminal,
      "tool.call.started": onDispatchStarted,
    },
  };
}

function toolContext(state: AgentActionTraceState): AgentToolContext {
  return {
    context: withChannelAudience(
      trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(state.context)),
      state.channelAudience,
    ),
    spanContext: state.context,
  };
}
