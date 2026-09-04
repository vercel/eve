import type { Approval } from "#approval/definition.js";
import { resolveApprovalPolicy } from "#approval/definition.js";
import type { JsonObject } from "#shared/json.js";

export type DurableDynamicCallbackPhase =
  | "labelComplete"
  | "labelDelta"
  | "labelStart"
  | "approvalRequest"
  | "approvalResponse"
  | "execute"
  | "toModelOutput";

export type DurableDynamicCallbackFn = (closure: JsonObject, ...args: never[]) => unknown;

/**
 * Persisted binding for one callback phase. Identity is
 * `(toolName, phase)` — carried by the surrounding metadata — so only the
 * snapshotted closure values persist.
 */
export interface DurableDynamicCallbackReference {
  readonly closure: JsonObject;
  readonly stepId?: never;
}

export interface DurableDynamicToolCallbacks {
  readonly execute: DurableDynamicCallbackReference;
  readonly label?: {
    readonly complete?: DurableDynamicCallbackReference;
    readonly delta?: DurableDynamicCallbackReference;
    readonly start?: DurableDynamicCallbackReference;
  };
  readonly approvalRequest?: DurableDynamicCallbackReference;
  readonly approvalResponse?: DurableDynamicCallbackReference;
  readonly toModelOutput?: DurableDynamicCallbackReference;
}

/** Live descriptor stamped on authored callbacks; `callback` never persists. */
export interface StampedDurableDynamicCallback {
  readonly callback: DurableDynamicCallbackFn;
  readonly closure: JsonObject;
}

export type LiveDurableDynamicToolCallbacks = Partial<{
  execute: StampedDurableDynamicCallback;
  label: {
    readonly complete?: StampedDurableDynamicCallback;
    readonly delta?: StampedDurableDynamicCallback;
    readonly start?: StampedDurableDynamicCallback;
  };
  approvalRequest: StampedDurableDynamicCallback;
  approvalResponse: StampedDurableDynamicCallback;
  toModelOutput: StampedDurableDynamicCallback;
}>;

const STAMPED_CALLBACK = Symbol.for("eve:durable-dynamic-callback");
export const DURABLE_DYNAMIC_TOOL_CALLBACKS = Symbol.for("eve:durable-dynamic-tool-callbacks");

const REGISTRY = Symbol.for("eve:dynamic-tool-callbacks");

type Registry = Map<string, Map<DurableDynamicCallbackPhase, DurableDynamicCallbackFn>>;

function getRegistry(): Registry {
  const global = globalThis as Record<symbol, Registry | undefined>;
  const existing = global[REGISTRY];
  if (existing !== undefined) return existing;

  const registry: Registry = new Map();
  global[REGISTRY] = registry;
  return registry;
}

/**
 * Binds the current implementation of one tool callback phase. Re-resolution
 * replaces the binding, so replay after a redeploy runs the latest code.
 */
export function registerDurableDynamicCallback(input: {
  readonly callback: DurableDynamicCallbackFn;
  readonly phase: DurableDynamicCallbackPhase;
  readonly toolName: string;
}): void {
  const registry = getRegistry();
  let phases = registry.get(input.toolName);
  if (phases === undefined) {
    phases = new Map();
    registry.set(input.toolName, phases);
  }
  phases.set(input.phase, input.callback);
}

export function lookupDurableDynamicCallback(
  toolName: string,
  phase: DurableDynamicCallbackPhase,
): DurableDynamicCallbackFn | undefined {
  return getRegistry().get(toolName)?.get(phase);
}

/** Invokes a registered callback with its snapshotted closure and live arguments. */
export function callDurableDynamicCallback(
  callback: DurableDynamicCallbackFn,
  closure: JsonObject,
  ...args: unknown[]
): unknown {
  return (callback as (closure: JsonObject, ...args: unknown[]) => unknown)(closure, ...args);
}

/** True when any persisted callback of these tools has no registered binding. */
export function hasUnregisteredDurableDynamicCallbacks(
  metadata: readonly { callbacks: DurableDynamicToolCallbacks; name: string }[],
): boolean {
  return metadata.some((entry) =>
    durableCallbackPhases(entry.callbacks).some(
      (phase) => lookupDurableDynamicCallback(entry.name, phase) === undefined,
    ),
  );
}

function durableCallbackPhases(
  callbacks: DurableDynamicToolCallbacks,
): DurableDynamicCallbackPhase[] {
  const entries: readonly (readonly [
    DurableDynamicCallbackPhase,
    DurableDynamicCallbackReference | undefined,
  ])[] = [
    ["execute", callbacks.execute],
    ["labelComplete", callbacks.label?.complete],
    ["labelDelta", callbacks.label?.delta],
    ["labelStart", callbacks.label?.start],
    ["approvalRequest", callbacks.approvalRequest],
    ["approvalResponse", callbacks.approvalResponse],
    ["toModelOutput", callbacks.toModelOutput],
  ];
  return entries.flatMap(([phase, reference]) => (reference === undefined ? [] : [phase]));
}

/** Marks a live callback with the descriptor needed to register it at resolve time. */
export function stampDurableDynamicCallback<TCallback extends (...args: never[]) => unknown>(
  callback: TCallback,
  descriptor: StampedDurableDynamicCallback,
): TCallback {
  Object.defineProperty(callback, STAMPED_CALLBACK, {
    configurable: true,
    value: descriptor,
  });
  return callback;
}

export function readDurableDynamicCallback(
  callback: unknown,
): StampedDurableDynamicCallback | undefined {
  if (typeof callback !== "function") return undefined;
  return Reflect.get(callback, STAMPED_CALLBACK) as StampedDurableDynamicCallback | undefined;
}

/** Copies phase-specific callback descriptors onto a branded tool definition. */
export function stampDurableDynamicToolCallbacks(
  definition: object,
  callbacks: LiveDurableDynamicToolCallbacks,
): void {
  Object.defineProperty(definition, DURABLE_DYNAMIC_TOOL_CALLBACKS, {
    configurable: true,
    value: callbacks,
  });
}

export function collectDurableDynamicToolCallbacks(input: {
  readonly label?: {
    readonly complete?: (...args: never[]) => unknown;
    readonly delta?: (...args: never[]) => unknown;
    readonly start?: (...args: never[]) => unknown;
  };
  readonly approval?: Approval<never>;
  readonly execute: (...args: never[]) => unknown;
  readonly toModelOutput?: (...args: never[]) => unknown;
}): LiveDurableDynamicToolCallbacks {
  const labelComplete = readDurableDynamicCallback(input.label?.complete);
  const labelDelta = readDurableDynamicCallback(input.label?.delta);
  const labelStart = readDurableDynamicCallback(input.label?.start);
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
  const callbacks: LiveDurableDynamicToolCallbacks = {};
  if (execute !== undefined) callbacks.execute = execute;
  if (labelComplete !== undefined || labelDelta !== undefined || labelStart !== undefined) {
    callbacks.label = {
      complete: labelComplete,
      delta: labelDelta,
      start: labelStart,
    };
  }
  if (approvalRequest !== undefined) callbacks.approvalRequest = approvalRequest;
  if (approvalResponse !== undefined) callbacks.approvalResponse = approvalResponse;
  if (toModelOutput !== undefined) callbacks.toModelOutput = toModelOutput;
  return callbacks;
}

export function readDurableDynamicToolCallbacks(
  definition: object,
): LiveDurableDynamicToolCallbacks | undefined {
  return (definition as Record<symbol, unknown>)[DURABLE_DYNAMIC_TOOL_CALLBACKS] as
    | LiveDurableDynamicToolCallbacks
    | undefined;
}
