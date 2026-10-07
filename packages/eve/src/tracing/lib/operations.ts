import type { LiveOperation } from "./core/scopes.js";
import type {
  StepOptions,
  TraceLink,
  ScopeData,
  ScopeTerminal,
  ModelOptions,
  ToolOptions,
  ModelResult,
  CaptureDecision,
  Attributes,
  TraceReference,
  TraceErrorHandler,
} from "./core/types.js";

type Completion = ScopeTerminal & { errorType?: string; result?: ModelResult };
export interface Operation {
  readonly type: ScopeData["type"];
  readonly reference: TraceReference;
  readonly parent?: TraceReference;
  readonly startTimeMs: number;
  readonly finished: boolean;
  readonly capture: CaptureDecision;
  run<T>(execute: () => T, ceiling?: CaptureDecision): T;
  attributes(attributes: Attributes): void;
  complete(result?: Completion): Promise<void>;
  fail(error: unknown): Promise<void>;
  /** Records a failure without ending the operation; completion keeps it. */
  recordError(error: unknown, errorType?: string): void;
}
export interface WrappedOperation<I, H extends Operation> {
  (input: I): Promise<H>;
  <T>(
    input: I & { describe?: (value: T) => Completion },
    execute: (operation: H) => T | PromiseLike<T>,
  ): Promise<T>;
}
type MemoryInput = Extract<ScopeData, { type: "memory" }>["options"];
export interface AttemptInput {
  readonly stepIndex: number;
  readonly attempt: number;
  readonly runtimeContext?: StepOptions["runtimeContext"];
  readonly channel?: StepOptions["channel"];
  readonly links?: readonly TraceLink[];
}
export interface TurnOperation extends Operation {
  attempt: WrappedOperation<AttemptInput, AttemptOperation>;
  /** Returns an open attempt without starting one. Durable turns only. */
  findAttempt(input: { stepIndex: number; attempt: number }): AttemptOperation | undefined;
  /** Returns an open tool call from any attempt of this turn. Durable turns only. */
  findTool(callId: string): ToolOperation | undefined;
  /** Replaces the turn's links before its deferred span is exported. */
  links(links: readonly TraceLink[]): void;
  memory: WrappedOperation<MemoryInput, MemoryOperation>;
}
/**
 * One tool call. In a durable turn, calling `tool` again with the same `callId`
 * returns the same call and fills in details it did not have, such as `kind`,
 * `arguments`, or an earlier `startTimeMs`.
 */
export interface ToolInput extends Omit<ToolOptions, "parentCallId"> {
  readonly startTimeMs?: number;
}
export interface AttemptOperation extends Operation {
  tool: WrappedOperation<ToolInput, ToolOperation>;
  callSubAgent: WrappedOperation<{ callId: string; agentName: string }, ToolOperation>;
  callRemoteAgent: WrappedOperation<{ callId: string; agentName: string }, ToolOperation>;
  modelCall(input: ModelOptions, key?: string): Promise<ModelOperation>;
  modelCall<T>(
    input: ModelOptions,
    execute: () => ModelCallReturn<T> | PromiseLike<ModelCallReturn<T>>,
  ): Promise<T>;
  modelStream<T>(
    input: ModelOptions,
    execute: () => ModelStreamReturn<T> | PromiseLike<ModelStreamReturn<T>>,
  ): Promise<T>;
  memory: WrappedOperation<MemoryInput, MemoryOperation>;
}
export interface ToolOperation extends Operation {
  approval: WrappedOperation<{ requestId: string; request?: unknown }, ApprovalOperation>;
  /** Returns an open approval without starting one. Durable turns only. */
  findApproval(requestId: string): ApprovalOperation | undefined;
  /** A tool call made while this tool runs, such as a connector's nested call. */
  tool: WrappedOperation<ToolInput, ToolOperation>;
  memory: WrappedOperation<MemoryInput, MemoryOperation>;
}
export type ModelOperation = Operation;
export type ApprovalOperation = Operation;
export type MemoryOperation = Operation;
export interface ModelCallReturn<T> extends ModelResult {
  readonly result: T;
}
export interface ModelStreamReturn<T> {
  readonly result: T;
  readonly completion: PromiseLike<ModelResult>;
}

function report(
  onError: TraceErrorHandler | undefined,
  error: unknown,
  phase: "start" | "complete",
) {
  try {
    onError?.(error, { phase });
  } catch {}
}
export function wrappedOperation<I, H extends Operation>(
  start: (input: I) => Promise<H>,
  fallback: Completion = { outcome: "completed" },
  onError?: TraceErrorHandler,
): WrappedOperation<I, H> {
  function invoke(input: I): Promise<H>;
  function invoke<T>(
    input: I & { describe?: (value: T) => Completion },
    execute: (operation: H) => T | PromiseLike<T>,
  ): Promise<T>;
  async function invoke<T>(
    input: I,
    execute?: (operation: H) => T | PromiseLike<T>,
  ): Promise<H | T> {
    if (execute === undefined) return start(input);
    const handle = await start(input);
    let completion = fallback;
    try {
      const value = await handle.run(() => execute(handle));
      try {
        completion =
          (input as I & { describe?: (value: T) => Completion }).describe?.(value) ?? fallback;
      } catch (error) {
        report(onError, error, "complete");
      }
      return value;
    } catch (error) {
      completion = {
        outcome: "failed",
        errorType: error instanceof Error ? error.name : "_OTHER",
        error,
      };
      throw error;
    } finally {
      try {
        await handle.complete(completion);
      } catch (error) {
        report(onError, error, "complete");
      }
    }
  }
  return invoke;
}

export function operationHandle(
  runtime: LiveOperation,
  data: ScopeData,
  onError?: TraceErrorHandler,
): TurnOperation | AttemptOperation | ToolOperation | Operation {
  const live = <T extends Operation>(handle: T): T =>
    Object.defineProperties(handle, {
      finished: { get: () => runtime.finished },
      capture: { get: () => runtime.capture },
      parent: { get: () => runtime.parent },
    });
  const common: Operation = {
    type: runtime.type,
    reference: runtime.reference,
    get startTimeMs() {
      return runtime.startTimeMs;
    },
    get parent() {
      return runtime.parent;
    },
    get finished() {
      return runtime.finished;
    },
    get capture() {
      return runtime.capture;
    },
    run: (execute, ceiling) => runtime.run(execute, ceiling),
    attributes: (attributes) => runtime.attributes(attributes),
    complete: (result) => runtime.complete(result),
    fail: (error) => runtime.fail(error),
    recordError: (error, errorType) => runtime.error(error, errorType),
  };
  const child = async (
    data: ScopeData,
    key?: string,
    options?: { links?: readonly TraceLink[]; startTimeMs?: number },
  ) => operationHandle(await runtime.child(data, key, options), data, onError);
  const tool = wrappedOperation(
    async ({ startTimeMs, ...options }: ToolInput) =>
      child({ type: "tool", options }, undefined, { startTimeMs }) as Promise<ToolOperation>,
    undefined,
    onError,
  );
  const found = <T>(operation: LiveOperation | undefined): T | undefined =>
    operation === undefined
      ? undefined
      : (operationHandle(operation, operation.record().data, onError) as T);
  const memory = wrappedOperation(
    async (options: MemoryInput) => child({ type: "memory", options }),
    undefined,
    onError,
  );
  if (data.type === "activation")
    return live({
      ...common,
      memory,
      links: (links: readonly TraceLink[]) => runtime.update({ links }),
      findAttempt: (input: { stepIndex: number; attempt: number }) =>
        found<AttemptOperation>(
          runtime.find({
            type: "step",
            options: { index: input.stepIndex, attempt: input.attempt },
          }),
        ),
      findTool: (callId: string) => found<ToolOperation>(findTool(runtime, callId)),
      attempt: wrappedOperation(
        async (input: AttemptInput) =>
          child(
            {
              type: "step",
              options: {
                index: input.stepIndex,
                attempt: input.attempt,
                runtimeContext: input.runtimeContext,
                channel: input.channel,
              },
            },
            undefined,
            { links: input.links },
          ) as Promise<AttemptOperation>,
        undefined,
        onError,
      ),
    });
  if (data.type === "step") {
    const delegation = (kind: string) =>
      wrappedOperation(
        async (input: { callId: string; agentName: string }) =>
          child({
            type: "tool",
            options: { callId: input.callId, name: input.agentName, kind },
          }) as Promise<ToolOperation>,
        undefined,
        onError,
      );
    const startModel = (options: ModelOptions, key?: string) =>
      child({ type: "model", options }, key);
    function modelCall(input: ModelOptions, key?: string): Promise<ModelOperation>;
    function modelCall<T>(
      input: ModelOptions,
      execute: () => ModelCallReturn<T> | PromiseLike<ModelCallReturn<T>>,
    ): Promise<T>;
    async function modelCall<T>(
      input: ModelOptions,
      execute?: string | (() => ModelCallReturn<T> | PromiseLike<ModelCallReturn<T>>),
    ): Promise<ModelOperation | T> {
      if (typeof execute !== "function") return startModel(input, execute);
      const handle = await startModel(input);
      let result: ModelCallReturn<T>;
      try {
        result = await handle.run(execute);
      } catch (error) {
        try {
          await handle.fail(error);
        } catch (tracingError) {
          report(onError, tracingError, "complete");
        }
        throw error;
      }
      try {
        await handle.complete({ outcome: "completed", result });
      } catch (error) {
        report(onError, error, "complete");
      }
      return result.result;
    }
    return live({
      ...common,
      memory,
      tool,
      callSubAgent: delegation("subagent-call"),
      callRemoteAgent: delegation("remote-agent-call"),
      modelCall,
      async modelStream(input, execute) {
        const handle = await startModel(input);
        try {
          const value = await handle.run(execute);
          const completion = Promise.resolve(value.completion)
            .then(
              (result) => handle.complete({ outcome: "completed", result }),
              (error) => handle.fail(error),
            )
            .catch((error) => report(onError, error, "complete"));
          runtime.waitUntil(completion);
          return value.result;
        } catch (error) {
          try {
            await handle.fail(error);
          } catch (tracingError) {
            report(onError, tracingError, "complete");
          }
          throw error;
        }
      },
    } as AttemptOperation);
  }
  if (data.type === "tool")
    return live({
      ...common,
      memory,
      tool,
      findApproval: (requestId: string) =>
        found<ApprovalOperation>(
          runtime.find({
            type: "approval",
            options: { requestId, callId: data.options.callId, toolName: data.options.name },
          }),
        ),
      approval: wrappedOperation(
        async (input: { requestId: string; request?: unknown }) =>
          child({
            type: "approval",
            options: { ...input, callId: data.options.callId, toolName: data.options.name },
          }),
        { outcome: "ignored" },
        onError,
      ),
    } as ToolOperation);
  return common;
}

/** Tool calls can nest, so a call ID is searched through every open call of the turn. */
function findTool(parent: LiveOperation, callId: string): LiveOperation | undefined {
  for (const next of parent.children) {
    if (next.type === "tool" && next.callId === callId) return next;
    if (next.type === "step" || next.type === "tool") {
      const found = findTool(next, callId);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}
