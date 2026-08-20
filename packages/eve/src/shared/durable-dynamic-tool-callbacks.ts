import type { Approval } from "#public/definitions/approval.js";
import { resolveApprovalPolicy } from "#public/definitions/approval.js";
import type { JsonObject } from "#shared/json.js";

export interface DurableDynamicCallbackReference {
  readonly stepId: string;
  readonly closure: JsonObject;
}

export interface DurableDynamicToolCallbacks {
  readonly execute: DurableDynamicCallbackReference;
  readonly approvalRequest?: DurableDynamicCallbackReference;
  readonly approvalResponse?: DurableDynamicCallbackReference;
  readonly toModelOutput?: DurableDynamicCallbackReference;
}

const DURABLE_CALLBACK_REFERENCE = Symbol.for("eve:durable-dynamic-callback");
export const DURABLE_DYNAMIC_TOOL_CALLBACKS = Symbol.for("eve:durable-dynamic-tool-callbacks");
const STEP_REGISTRY = Symbol.for("@workflow/core//registeredSteps");

type Callback = (...args: never[]) => unknown;

function getStepRegistry(): Map<string, Function> {
  const global = globalThis as Record<symbol, Map<string, Function> | undefined>;
  const existing = global[STEP_REGISTRY];
  if (existing !== undefined) return existing;

  const registry = new Map<string, Function>();
  global[STEP_REGISTRY] = registry;
  return registry;
}

/** Registers one module-stable replay entry point. Re-registration replaces the same code-owned id. */
export function registerDurableDynamicCallback<TArgs extends unknown[], TResult>(
  stepId: string,
  callback: (closure: JsonObject, ...args: TArgs) => TResult,
): void {
  if (stepId.length === 0) {
    throw new Error("A durable dynamic callback step id cannot be empty.");
  }
  getStepRegistry().set(stepId, callback);
}

/** Marks a live callback with the descriptor needed to reconstruct it after a cold start. */
export function stampDurableDynamicCallback<TCallback extends Callback>(
  callback: TCallback,
  reference: DurableDynamicCallbackReference,
): TCallback {
  Object.defineProperty(callback, DURABLE_CALLBACK_REFERENCE, {
    configurable: true,
    value: reference,
  });
  return callback;
}

/** Creates a live callback backed by the same registered function used during durable replay. */
export function createDurableDynamicCallback<TArgs extends unknown[], TResult>(input: {
  readonly closure: JsonObject;
  readonly callback: (closure: JsonObject, ...args: TArgs) => TResult;
  readonly stepId: string;
}): (...args: TArgs) => TResult {
  registerDurableDynamicCallback(input.stepId, input.callback);
  const callback = (...args: TArgs) => input.callback(input.closure, ...args);
  return stampDurableDynamicCallback(callback, {
    closure: input.closure,
    stepId: input.stepId,
  });
}

export function readDurableDynamicCallback(
  callback: unknown,
): DurableDynamicCallbackReference | undefined {
  if (typeof callback !== "function") return undefined;
  return Reflect.get(callback, DURABLE_CALLBACK_REFERENCE) as
    | DurableDynamicCallbackReference
    | undefined;
}

/** Copies phase-specific callback descriptors onto a branded tool definition. */
export function stampDurableDynamicToolCallbacks(
  definition: object,
  callbacks: Partial<DurableDynamicToolCallbacks>,
): void {
  Object.defineProperty(definition, DURABLE_DYNAMIC_TOOL_CALLBACKS, {
    configurable: true,
    value: callbacks,
  });
}

export function collectDurableDynamicToolCallbacks(input: {
  readonly approval?: Approval<never>;
  readonly execute: Callback;
  readonly toModelOutput?: Callback;
}): Partial<DurableDynamicToolCallbacks> {
  const approvalRequest =
    input.approval === undefined
      ? undefined
      : readDurableDynamicCallback(resolveApprovalPolicy(input.approval));
  const approvalResponse =
    input.approval === undefined || typeof input.approval === "function"
      ? undefined
      : readDurableDynamicCallback(input.approval.response);

  const execute = readDurableDynamicCallback(input.execute);
  const toModelOutput = readDurableDynamicCallback(input.toModelOutput);
  const callbacks: {
    execute?: DurableDynamicCallbackReference;
    approvalRequest?: DurableDynamicCallbackReference;
    approvalResponse?: DurableDynamicCallbackReference;
    toModelOutput?: DurableDynamicCallbackReference;
  } = {};
  if (execute !== undefined) callbacks.execute = execute;
  if (approvalRequest !== undefined) callbacks.approvalRequest = approvalRequest;
  if (approvalResponse !== undefined) callbacks.approvalResponse = approvalResponse;
  if (toModelOutput !== undefined) callbacks.toModelOutput = toModelOutput;
  return callbacks;
}

export function readDurableDynamicToolCallbacks(
  definition: object,
): Partial<DurableDynamicToolCallbacks> | undefined {
  return (definition as Record<symbol, unknown>)[DURABLE_DYNAMIC_TOOL_CALLBACKS] as
    | Partial<DurableDynamicToolCallbacks>
    | undefined;
}
