import type { ExecutionContext } from "./types.js";
import { createSpanWriter, type TraceOperation } from "./writer.js";
import { usageAttributes } from "./attributes.js";
import { applyAttributes } from "./contract.js";
import type { ContentSerializer } from "./model.js";
import type { Attributes, CaptureDecision, TraceBackend, TraceReference } from "./types.js";
import {
  completeScope,
  capturedScopeData as capturedData,
  prepareScope,
  parentKinds,
} from "./span-kinds.js";
import { mcpLifecycle } from "./mcp.js";
import { intersectCapture } from "./activation.js";
import { snapshotRecord, traceSnapshot, validSnapshot, checkpointSnapshot } from "./snapshot.js";
import type { Operation, OperationFacts } from "./types.js";
import { withAgentHandoff } from "./delegation.js";
import { boundedSerializer } from "./serializer.js";
import { withoutDeclinedContent } from "./content-policy.js";
import { runTraceContext } from "./context.js";
import { randomBytes, randomUUID } from "node:crypto";
const SERIALIZED_BYTES = 32768;
const UNFINISHED_CHILDREN = 10000;

import type { ScopeIdentity, ScopeData, ScopeRecord } from "./types.js";
type Construction = Partial<ScopeRecord> & {
  key: string;
  reservationKey?: string;
  parentKey?: string;
  deferred?: boolean;
  executionContext?: ExecutionContext;
};
interface LiveOperation extends Operation {
  child(data: ScopeData, key?: string): Promise<LiveOperation>;
  usage(usage: import("./types.js").Usage, key?: string): Promise<void>;
  error(error?: unknown, type?: string): void;
  readonly mcp: import("./mcp.js").McpLifecycle;
  record(): ScopeRecord;
}
export interface ToolCallInput {
  identity: ScopeIdentity;
  key: string;
  name: string;
  callId: string;
  arguments?: unknown;
  parent: TraceReference;
  capture: CaptureDecision;
  context?: ExecutionContext;
}
interface MemoryFacts<T> {
  identity: ScopeIdentity;
  storeId: string;
  slot: string;
  phase: string;
  capture?: CaptureDecision;
  parent?: TraceReference;
  context?: ExecutionContext;
  operationId?: string;
  describe?: (value: T) => {
    recordCount?: number;
    records?: readonly { id?: string; content: string }[];
  };
}

export function createTraceRecorder(input: {
  readonly output: TraceBackend;
  readonly serializer: ContentSerializer;
  readonly onError?: import("./types.js").TraceErrorHandler;
}) {
  const backend = input.output;
  input = {
    ...input,
    serializer: boundedSerializer(input.serializer, SERIALIZED_BYTES, input.onError),
  };
  const engine = createSpanWriter({ backend, onError: input.onError });
  const serializer = input.serializer;

  async function construct(
    identity: ScopeIdentity,
    capture: CaptureDecision,
    data: ScopeData,
    parent: LiveOperation | undefined,
    attempt: ScopeRecord["attempt"],
    binding: Construction,
  ): Promise<LiveOperation> {
    try {
      return await constructOperation(identity, capture, data, parent, attempt, binding);
    } catch (error) {
      try {
        input.onError?.(error, {
          phase: "start",
          operation: data.type,
          reference: binding.reference,
        });
      } catch {}
      return constructOperation(
        identity,
        { emit: false, recordInputs: false, recordOutputs: false },
        capturedData(data, { emit: false, recordInputs: false, recordOutputs: false }),
        parent,
        attempt,
        {
          ...binding,
          parentKey: undefined,
          reservationKey: undefined,
          reference: {
            traceId:
              binding.reference?.traceId ??
              parent?.reference.traceId ??
              binding.parent?.traceId ??
              randomBytes(16).toString("hex"),
            spanId: binding.reference?.spanId ?? randomBytes(8).toString("hex"),
            traceFlags: 0,
          },
        },
      );
    }
  }

  async function constructOperation(
    identity: ScopeIdentity,
    capture: CaptureDecision,
    data: ScopeData,
    parent: LiveOperation | undefined,
    attempt: ScopeRecord["attempt"],
    binding: Construction,
  ): Promise<LiveOperation> {
    if (
      binding.terminal?.error !== null &&
      typeof binding.terminal?.error === "object" &&
      !(binding.terminal.error instanceof Error) &&
      "message" in binding.terminal.error &&
      typeof binding.terminal.error.message === "string"
    ) {
      const error = new Error(binding.terminal.error.message);
      error.name = binding.terminal.errorCode ?? "Error";
      binding = { ...binding, terminal: { ...binding.terminal, error } };
    }
    const key = binding.key;
    const startTimeMs = binding.startTimeMs ?? Date.now();
    let parentReference =
      binding.parentKey !== undefined && binding.parent !== undefined
        ? backend.reserveChild(binding.parent, binding.parentKey)
        : (parent?.reference ?? binding.parent);
    if (capture.emit) capture = intersectCapture(capture, backend.active?.()?.capture);
    let actualCapture = capture;
    let actualData = capturedData(data, actualCapture);
    let prepared = prepareScope(
      {
        identity,
        data: actualData,
        attempt,
        capture: actualCapture,
        key,
        parent: parentReference,
        startTimeMs,
        links: binding.links,
      },
      serializer,
    );
    prepared = {
      ...prepared,
      attributes: { ...prepared.attributes, ...binding.attributes },
    };
    actualData = snapshotRecord(
      {
        key,
        identity,
        data: actualData,
        capture: actualCapture,
        reference: binding.reference ?? {
          traceId: "0".repeat(32),
          spanId: "0".repeat(16),
          traceFlags: 0,
        },
        startTimeMs,
      },
      input.serializer,
    ).data;
    const deferred = binding.deferred === true || binding.pendingParent === true;
    let pendingParent = binding.pendingParent === true;
    let host = binding.executionContext;
    let reference = binding.reference;
    if (reference === undefined && (deferred || binding.reservationKey !== undefined)) {
      reference =
        data.type === "activation"
          ? backend.reserveActivation({
              key: binding.reservationKey ?? key,
              span: prepared,
              capture: actualCapture,
            })
          : parentReference === undefined
            ? undefined
            : backend.reserveChild(parentReference, binding.reservationKey ?? key);
    }
    let operation: TraceOperation | undefined = deferred
      ? undefined
      : reference === undefined
        ? engine.start(prepared, actualCapture, binding?.executionContext)
        : engine.startReserved(prepared, reference, actualCapture, binding?.executionContext);
    reference ??= operation?.reference;
    if (reference === undefined)
      throw new Error("A child trace scope requires its constructed parent.");
    const retainedReference = reference;
    actualCapture = {
      emit: actualCapture.emit && (reference.traceFlags & 1) !== 0,
      recordInputs:
        actualCapture.emit && (reference.traceFlags & 1) !== 0 && actualCapture.recordInputs,
      recordOutputs:
        actualCapture.emit && (reference.traceFlags & 1) !== 0 && actualCapture.recordOutputs,
    };
    actualData = capturedData(actualData, actualCapture);
    let finished = binding.finished ?? false;
    let terminalResult = binding.terminal;
    const children = new Set<LiveOperation>();
    let childSequence = binding.childSequence ?? 0;
    let totalUsage = binding.usage;
    const usageKeys = new Set(binding.usageKeys ?? []);
    const enrichment: Record<string, Attributes[string]> = {};
    async function child(childData: ScopeData, childBinding: Construction): Promise<LiveOperation> {
      if (children.size >= UNFINISHED_CHILDREN) {
        for (const previous of children) if (previous.finished) children.delete(previous);
        if (children.size >= UNFINISHED_CHILDREN) {
          const error = new Error("Trace unfinished-child limit reached.");
          try {
            input.onError?.(error, {
              phase: "start",
              operation: childData.type,
              reference: retainedReference,
            });
          } catch {}
          return construct(
            identity,
            { emit: false, recordInputs: false, recordOutputs: false },
            childData,
            runtime,
            attempt,
            childBinding,
          );
        }
      }
      if (childData.type === "model" && operation !== undefined)
        applyAttributes(operation, {
          "agent.model.id": childData.options.modelId,
          "agent.model.provider": childData.options.provider,
        });
      const next = await construct(
        identity,
        actualCapture,
        childData,
        runtime,
        attempt,
        childBinding,
      );
      children.add(next);
      return next;
    }
    const runtime: LiveOperation = {
      snapshot: () => traceSnapshot(runtime.record()),
      attributes: (attributes) => runtime.update({ attributes }),
      modelCall: (options, key) => runtime.child({ type: "model", options }, key),
      fail(error) {
        runtime.error(error);
        return runtime.complete({ outcome: "failed", failed: true });
      },
      async attach(reference, context) {
        if (finished || !pendingParent) return;
        parentReference = reference;
        prepared = { ...prepared, parent: reference };
        host = context ?? host;
        pendingParent = false;
        if (terminalResult !== undefined) await runtime.complete(terminalResult);
      },
      async drain(result = {}) {
        pendingParent = false;
        await runtime.complete(terminalResult ?? result);
      },
      update(update) {
        if (finished) return;
        const attributes = (withoutDeclinedContent(update.attributes ?? {}, actualCapture) ??
          update.attributes) as Attributes;
        if (actualData.type === "activation")
          actualData = {
            ...actualData,
            options: {
              ...actualData.options,
              attributes: { ...actualData.options.attributes, ...attributes },
            },
          };
        prepared = {
          ...prepared,
          attributes: { ...prepared.attributes, ...attributes },
          links: update.links ?? prepared.links,
        };
        if (operation !== undefined) applyAttributes(operation, attributes);
      },
      record() {
        return snapshotRecord(
          {
            version: 1,
            pendingParent,
            finished,
            terminal: terminalResult,
            usage: totalUsage,
            usageKeys: [...usageKeys],
            attributes: { ...prepared.attributes, ...enrichment },
            childSequence,
            children: [...children]
              .filter((child) => !child.finished)
              .map((child) => child.record()),
            key,
            identity,
            data: actualData,
            capture: actualCapture,
            reference: retainedReference,
            parent: parentReference,
            startTimeMs,
            attempt,
            links: prepared.links,
          },
          serializer,
        );
      },
      get parent() {
        return parentReference;
      },
      startTimeMs,
      child(data, childKey) {
        if (finished || !parentKinds(data).includes(actualData.type))
          throw new Error("The operation is not permitted in this trace scope.");
        return child(data, { key: childKey ?? JSON.stringify([key, data.type, childSequence++]) });
      },
      type: actualData.type,
      reference: retainedReference,
      get capture() {
        return actualCapture;
      },
      mcp: mcpLifecycle({
        serializer: input.serializer,
        ...actualCapture,
        write(attributes) {
          const permitted = (withoutDeclinedContent(attributes, actualCapture) ??
            attributes) as Attributes;
          Object.assign(enrichment, permitted);
          if (operation !== undefined) applyAttributes(operation, permitted);
        },
        error(error, type) {
          runtime.error(error, type);
        },
      }),
      get finished() {
        return finished;
      },
      run(execute, ceiling) {
        if (finished) throw new Error("The trace scope has already finished.");
        actualCapture = intersectCapture(
          intersectCapture(actualCapture, ceiling),
          backend.active?.()?.capture,
        );
        actualData = capturedData(actualData, actualCapture);
        if (!actualCapture.recordOutputs && terminalResult !== undefined)
          terminalResult = { ...terminalResult, error: undefined };
        prepared = {
          ...prepared,
          attributes: (withoutDeclinedContent(prepared.attributes, actualCapture) ??
            prepared.attributes) as Attributes,
        };
        const permitted = withoutDeclinedContent(enrichment, actualCapture) ?? enrichment;
        for (const key of Object.keys(enrichment)) if (!(key in permitted)) delete enrichment[key];
        const callback =
          actualData.type === "action" &&
          (actualData.options.kind === "subagent-call" ||
            actualData.options.kind === "remote-agent-call")
            ? () =>
                withAgentHandoff(
                  {
                    caller: retainedReference,
                    conversationId: identity.conversationId,
                    parentRunId: identity.runId,
                    parentCallId: actualData.type === "action" ? actualData.options.callId : "",
                    agentName: actualData.type === "action" ? actualData.options.name : "",
                    capture: actualCapture,
                  },
                  execute,
                )
            : execute;
        return runTraceContext(backend, retainedReference, actualCapture, callback, host, runtime);
      },
      async complete(result = terminalResult ?? {}) {
        if (finished) return;
        if (terminalResult?.failed)
          result = {
            ...result,
            failed: true,
            error: terminalResult.error,
            errorCode: terminalResult.errorCode,
          };
        result = {
          ...result,
          model: "result" in result ? result.result : result.model,
          failed: result.failed || result.outcome === "failed",
          errorCode: "errorType" in result ? result.errorType : result.errorCode,
        };
        if (pendingParent) {
          terminalResult = {
            ...result,
            output: actualCapture.recordOutputs ? result.output : undefined,
            error: actualCapture.recordOutputs ? result.error : undefined,
          };
          return;
        }
        finished = true;
        terminalResult = result;
        for (const next of children)
          if (!next.finished)
            await next.complete({
              failed: result.failed,
              error: result.error,
              outcome: "abandoned",
            });
        operation ??= engine.startReserved(prepared, retainedReference, actualCapture, host);
        const terminal =
          actualData.type === "activation" && result.usage === undefined
            ? { ...result, usage: totalUsage }
            : result;
        try {
          completeScope(
            operation,
            actualData,
            terminal,
            actualCapture,
            startTimeMs,
            input.serializer,
          );
        } catch (error) {
          try {
            input.onError?.(error, {
              phase: "complete",
              operation: actualData.type,
              reference: retainedReference,
            });
          } catch {}
        }
        applyAttributes(operation, enrichment);
        if (actualData.type === "model" && result.model !== undefined)
          await parent?.usage(result.model.usage, key);
        operation.end(result.endTimeMs);
      },
      async usage(usage, callKey) {
        if (callKey !== undefined && usageKeys.has(callKey)) return;
        if (callKey !== undefined) usageKeys.add(callKey);
        if (operation !== undefined) applyAttributes(operation, usageAttributes(usage));
        totalUsage = {
          inputTokens:
            usage.inputTokens === undefined
              ? totalUsage?.inputTokens
              : (totalUsage?.inputTokens ?? 0) + usage.inputTokens,
          outputTokens:
            usage.outputTokens === undefined
              ? totalUsage?.outputTokens
              : (totalUsage?.outputTokens ?? 0) + usage.outputTokens,
          costUsd:
            usage.costUsd === undefined
              ? totalUsage?.costUsd
              : (totalUsage?.costUsd ?? 0) + usage.costUsd,
        };
        await parent?.usage(usage, callKey);
      },
      error(error, errorType) {
        terminalResult = {
          ...terminalResult,
          failed: true,
          error: actualCapture.recordOutputs ? error : undefined,
          errorCode: errorType ?? (error instanceof Error ? error.name : undefined),
        };
        if (operation !== undefined) operation.fail(terminalResult.error, terminalResult.errorCode);
      },
    };
    for (const saved of binding.children ?? [])
      children.add(
        await construct(
          saved.identity,
          intersectCapture(saved.capture, actualCapture),
          saved.data,
          runtime,
          saved.attempt,
          { ...saved, deferred: true, executionContext: binding.executionContext },
        ),
      );
    if (!finished && operation !== undefined && actualData.type === "step")
      operation.addEvent("step.started", undefined, startTimeMs);
    return runtime;
  }

  function restore(
    record: ScopeRecord,
    options: { deferred?: boolean; executionContext?: import("./types.js").ExecutionContext } = {},
  ) {
    return construct(record.identity, record.capture, record.data, undefined, record.attempt, {
      ...record,
      deferred: options.deferred,
      executionContext: options.executionContext,
    });
  }

  async function start(
    facts: OperationFacts,
    data: ScopeData,
    binding: Partial<Construction> = {},
  ): Promise<Operation> {
    return construct(facts.identity, facts.capture, data, undefined, facts.attempt, {
      key: facts.operationId,
      reference: facts.reference,
      parent: facts.parent,
      startTimeMs: facts.startTimeMs,
      links: facts.links,
      executionContext: facts.context,
      attributes: facts.attributes,
      deferred: data.type !== "step" && data.type !== "memory",
      ...binding,
    });
  }
  async function resume(
    snapshot: unknown,
    options: { capture?: CaptureDecision; context?: ExecutionContext } = {},
  ): Promise<Operation | undefined> {
    if (!validSnapshot(snapshot)) {
      try {
        input.onError?.(new Error("Invalid tracing snapshot"), { phase: "restore" });
      } catch {}
      return undefined;
    }
    return restore(
      { ...snapshot, capture: intersectCapture(snapshot.capture, options.capture) },
      { deferred: true, executionContext: options.context },
    );
  }
  async function memory<T>(
    operation: "search_memory" | "upsert_memory",
    data: MemoryFacts<T>,
    execute: () => T | PromiseLike<T>,
  ): Promise<T> {
    const active = backend.active?.();
    const handle = await start(
      {
        ...data,
        operationId: data.operationId ?? randomUUID(),
        parent: data.parent ?? active?.reference,
        capture: data.capture ??
          active?.capture ?? { emit: true, recordInputs: false, recordOutputs: false },
      },
      {
        type: "memory",
        options: { operation, phase: data.phase, slot: data.slot, storeId: data.storeId },
      },
    );
    let value: T;
    try {
      value = await handle.run(execute);
    } catch (error) {
      try {
        await handle.fail(error);
      } catch (tracingError) {
        try {
          input.onError?.(tracingError, { phase: "complete" });
        } catch {}
      }
      throw error;
    }
    try {
      await handle.complete({ outcome: "completed", ...data.describe?.(value) });
    } catch (error) {
      try {
        input.onError?.(error, { phase: "complete" });
      } catch {}
    }
    return value;
  }
  return {
    resume,
    checkpoint(snapshot: unknown, update: Parameters<typeof checkpointSnapshot>[1]) {
      const saved = checkpointSnapshot(snapshot, update, serializer);
      return saved === undefined ? undefined : traceSnapshot(saved);
    },
    session(identity: ScopeIdentity, capture: CaptureDecision) {
      return backend.reserveReference({
        key: `session:${identity.runId}`,
        traceFlags: capture.emit ? 1 : 0,
      });
    },
    turnReference(key: string, capture: CaptureDecision) {
      return backend.reserveReference({ key: `turn:${key}`, traceFlags: capture.emit ? 1 : 0 });
    },
    turn(facts: OperationFacts & { metadata: import("./types.js").TurnMetadata }) {
      return start(facts, { type: "activation", options: facts.metadata });
    },
    attempt(facts: OperationFacts & { step: import("./types.js").StepOptions }) {
      return start(
        facts,
        { type: "step", options: facts.step },
        { reservationKey: facts.operationId },
      );
    },
    action(
      facts: OperationFacts & {
        action: import("./types.js").ActionOptions;
        parentAttemptId: string;
      },
    ) {
      return start(
        facts,
        { type: "action", options: facts.action },
        {
          reservationKey: `action:${facts.operationId}`,
          parentKey: `step:${facts.parentAttemptId}`,
        },
      );
    },
    approval(
      facts: OperationFacts & { approval: Extract<ScopeData, { type: "approval" }>["options"] },
    ) {
      return start(
        facts,
        { type: "approval", options: facts.approval },
        { reservationKey: `approval:${facts.operationId}` },
      );
    },
    memory: {
      search<T>(data: MemoryFacts<T>, execute: () => T | PromiseLike<T>) {
        return memory("search_memory", data, execute);
      },
      write<T>(data: MemoryFacts<T>, execute: () => T | PromiseLike<T>) {
        return memory("upsert_memory", data, execute);
      },
    },
    active: () => backend.active?.(),
    async pendingTool(input: ToolCallInput): Promise<Operation> {
      return construct(
        input.identity,
        input.capture,
        {
          type: "tool",
          options: { callId: input.callId, name: input.name, arguments: input.arguments },
        },
        undefined,
        undefined,
        {
          key: input.key,
          parent: input.parent,
          reference: backend.reserveReference({
            key: `tool:${input.key}`,
            parent: input.parent,
            traceFlags: input.parent.traceFlags,
          }),
          pendingParent: true,
          executionContext: input.context,
        },
      );
    },
    resumeTool(snapshot: unknown, context?: ExecutionContext) {
      return validSnapshot(snapshot) && snapshot.data.type === "tool"
        ? resume(snapshot, { context })
        : Promise.resolve(undefined);
    },
    run<T>(
      reference: TraceReference,
      capture: CaptureDecision,
      execute: () => T,
      executionContext?: import("./types.js").ExecutionContext,
    ) {
      const active = backend.active?.();
      return runTraceContext(
        backend,
        reference,
        capture,
        execute,
        executionContext,
        active?.reference.spanId === reference.spanId &&
          active.reference.traceId === reference.traceId
          ? active
          : undefined,
      );
    },
    sample(snapshot: unknown) {
      return (
        validSnapshot(snapshot) &&
        backend.admits(prepareScope(snapshot, serializer), snapshot.reference)
      );
    },
  };
}
