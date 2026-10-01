import { createTraceEngine, type TraceOperation } from "#tracing/core/engine.js";
import {
  frameworkAttributes,
  identityAttributes,
  namingAttributes,
  runtimeContextAttributes,
  usageAttributes,
} from "#tracing/core/attributes.js";
import type {
  Attributes,
  CaptureDecision,
  FrameworkIdentity,
  RunIdentity,
  TraceBackend,
  TraceLink,
  Usage,
} from "#tracing/core/types.js";
import type { ContentSerializer } from "#tracing/core/model.js";
import { modelInputAttributes, modelResultAttributes } from "#tracing/core/model.js";

export type ActionKind = "load-skill" | "remote-agent-call" | "subagent-call" | "tool-call";
export type ActionOutcome = "abandoned" | "cancelled" | "completed" | "failed" | "rejected";

/** Prepared operations shared by SDK and framework adapters. */
export function createAgentOperations(input: {
  readonly backend: TraceBackend;
  readonly identity: RunIdentity;
  readonly framework: FrameworkIdentity;
  readonly agentName?: string;
  readonly capture: CaptureDecision;
  readonly serializer: ContentSerializer;
  readonly diagnostic?: (code: string) => void;
}) {
  const engine = createTraceEngine(input);
  const identity = identityAttributes(input.identity);
  const framework = frameworkAttributes(input.framework);
  const capture = input.capture;
  function payload(
    operation: TraceOperation,
    key: string,
    value: unknown,
    direction: "input" | "output",
  ): void {
    if (!(direction === "input" ? capture.recordInputs : capture.recordOutputs)) return;
    const serialized = input.serializer.json(value);
    if (serialized !== undefined) operation.setAttribute(key, serialized);
  }
  function base(
    parent: TraceOperation,
    operationId: string,
    type: "step" | "model" | "action" | "tool" | "approval" | "memory",
    name: string,
    attributes: Attributes,
    operation = name,
    kind: "INTERNAL" | "CLIENT" = "INTERNAL",
  ): TraceOperation {
    return engine.start(
      {
        type,
        operationId,
        name,
        kind,
        parent: parent.reference,
        attributes: { ...identity, ...namingAttributes(name, operation), ...attributes },
      },
      capture,
    );
  }
  return {
    engine,
    step(
      parent: TraceOperation,
      options: {
        operationId: string;
        index: number;
        attempt: number;
        runtimeContext?: Readonly<Record<string, unknown>>;
        links?: readonly TraceLink[];
      },
    ): TraceOperation {
      const operation = engine.start(
        {
          type: "step",
          operationId: options.operationId,
          name: "agent.step",
          kind: "INTERNAL",
          parent: parent.reference,
          links: options.links,
          attributes: {
            ...identity,
            ...framework,
            ...namingAttributes("agent.step"),
            "agent.turn.id": input.identity.turnId,
            "agent.step.index": options.index,
            "agent.step.attempt": options.attempt,
            "agent.name": input.agentName,
            ...runtimeContextAttributes(options.runtimeContext),
          },
        },
        capture,
      );
      operation.addEvent("step.started");
      return operation;
    },
    model(
      parent: TraceOperation,
      options: {
        operationId: string;
        provider: string;
        modelId: string;
        messages?: readonly unknown[];
        instructions?: unknown;
        runtimeContext?: Readonly<Record<string, unknown>>;
      },
    ): TraceOperation {
      parent.setAttribute("agent.model.id", options.modelId);
      parent.setAttribute("agent.model.provider", options.provider);
      return base(
        parent,
        options.operationId,
        "model",
        `chat ${options.modelId}`,
        {
          "gen_ai.agent.name": input.agentName,
          "gen_ai.operation.name": "chat",
          "gen_ai.provider.name": options.provider,
          "gen_ai.request.model": options.modelId,
          ...runtimeContextAttributes(options.runtimeContext),
          ...(capture.recordInputs && options.messages !== undefined
            ? modelInputAttributes(
                { messages: options.messages, instructions: options.instructions },
                input.serializer,
              )
            : undefined),
        },
        "chat",
        "CLIENT",
      );
    },
    completeModel(
      operation: TraceOperation,
      result: Parameters<typeof modelResultAttributes>[0],
    ): void {
      if (operation.finished) return;
      engine.annotate(
        operation,
        modelResultAttributes(result, input.serializer, capture.recordOutputs),
      );
      operation.end();
    },
    action(
      parent: TraceOperation,
      options: {
        operationId: string;
        callId: string;
        name: string;
        kind: ActionKind;
        stepIndex: number;
        attempt: number;
        arguments?: unknown;
      },
    ): TraceOperation {
      const invocation = options.kind === "subagent-call" || options.kind === "remote-agent-call";
      const operation = base(
        parent,
        options.operationId,
        "action",
        "agent.action",
        {
          ...framework,
          "agent.turn.id": input.identity.turnId,
          "agent.step.index": options.stepIndex,
          "agent.step.attempt": options.attempt,
          "agent.action.call_id": options.callId,
          "agent.action.name": options.name,
          "agent.action.kind": options.kind,
          ...(invocation
            ? { "agent.invocation.role": "caller", "gen_ai.agent.name": options.name }
            : undefined),
        },
        "agent.action",
        options.kind === "remote-agent-call" ? "CLIENT" : "INTERNAL",
      );
      if (!invocation) payload(operation, "gen_ai.tool.call.arguments", options.arguments, "input");
      return operation;
    },
    tool(
      parent: TraceOperation,
      options: { operationId: string; callId: string; name: string; arguments?: unknown },
    ): TraceOperation {
      const operation = base(
        parent,
        options.operationId,
        "tool",
        `execute_tool ${options.name}`,
        {
          "gen_ai.agent.name": input.agentName,
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.call.id": options.callId,
          "gen_ai.tool.name": options.name,
          "gen_ai.tool.type": "function",
        },
        "execute_tool",
      );
      payload(operation, "gen_ai.tool.call.arguments", options.arguments, "input");
      return operation;
    },
    completeAction(
      operation: TraceOperation,
      options: {
        outcome: ActionOutcome;
        output?: unknown;
        error?: unknown;
        errorCode?: string;
        usage?: Usage;
        invocation?: boolean;
      },
    ): void {
      if (operation.finished) return;
      operation.setAttribute("agent.action.outcome", options.outcome);
      if (options.usage !== undefined) engine.annotate(operation, usageAttributes(options.usage));
      if (options.outcome === "failed" || options.error !== undefined) {
        if (options.errorCode !== undefined)
          operation.setAttribute("agent.action.error.code", options.errorCode);
        operation.fail(options.error, options.errorCode);
      } else if (!options.invocation)
        payload(operation, "gen_ai.tool.call.result", options.output, "output");
      operation.end();
    },
    completeTool(
      operation: TraceOperation,
      result: { type: "result"; output?: unknown } | { type: "error"; error?: unknown },
    ): void {
      if (operation.finished) return;
      if (result.type === "error") operation.fail(result.error);
      else payload(operation, "gen_ai.tool.call.result", result.output, "output");
      operation.end();
    },
    approval(
      parent: TraceOperation,
      options: {
        operationId: string;
        callId: string;
        actionName: string;
        requestId: string;
        stepIndex: number;
        attempt: number;
        request?: unknown;
      },
    ): TraceOperation {
      const operation = base(parent, options.operationId, "approval", "agent.approval", {
        ...framework,
        "agent.turn.id": input.identity.turnId,
        "agent.step.index": options.stepIndex,
        "agent.step.attempt": options.attempt,
        "agent.action.call_id": options.callId,
        "agent.action.name": options.actionName,
        "agent.approval.kind": "tool-approval",
        "agent.approval.request_id": options.requestId,
      });
      payload(operation, "agent.approval.request", options.request, "input");
      return operation;
    },
    completeApproval(
      operation: TraceOperation,
      options: {
        outcome:
          | "answered"
          | "approved"
          | "cancelled"
          | "denied"
          | "failed"
          | "ignored"
          | "invalid";
        response?: unknown;
        error?: unknown;
      },
    ): void {
      if (operation.finished) return;
      operation.setAttribute("agent.approval.outcome", options.outcome);
      payload(operation, "agent.approval.response", options.response, "output");
      if (options.outcome === "failed") operation.fail(options.error);
      operation.end();
    },
    memory(
      parent: TraceOperation,
      options: {
        operationId: string;
        operation: "search_memory" | "upsert_memory";
        phase: string;
        slot: string;
        storeId: string;
      },
    ): TraceOperation {
      return base(
        parent,
        options.operationId,
        "memory",
        options.operation,
        {
          "agent.turn.id": input.identity.turnId,
          "gen_ai.operation.name": options.operation,
          "gen_ai.memory.store.id": options.storeId,
          "agent.memory.phase": options.phase,
          "agent.memory.slot": options.slot,
        },
        options.operation,
        "CLIENT",
      );
    },
    completeMemory(
      operation: TraceOperation,
      options: { recordCount?: number; records?: readonly { id?: string; content: string }[] },
    ): void {
      if (operation.finished) return;
      if (options.recordCount !== undefined)
        operation.setAttribute("gen_ai.memory.record.count", options.recordCount);
      payload(operation, "gen_ai.memory.records", options.records, "input");
      operation.end();
    },
  };
}
