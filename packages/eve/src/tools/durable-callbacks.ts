import type { Approval } from "#approval/definition.js";
import { resolveApprovalPolicy } from "#approval/definition.js";
import type { JsonObject } from "#shared/json.js";

export type DurableDynamicCallbackPhase =
  | "approvalKey"
  | "approvalRequest"
  | "approvalResponse"
  | "execute"
  | "toModelOutput";

export type DurableDynamicCallbackFn = (closure: JsonObject, ...args: never[]) => unknown;

/**
 * Persisted binding for one callback phase. Identity is
 * session, lifecycle scope, resolver, entry, tool name, and phase — carried
 * by the surrounding context and metadata — so only the
 * snapshotted closure values persist.
 */
export interface DurableDynamicCallbackReference {
  readonly closure: JsonObject;
  readonly stepId?: never;
}

export interface DurableDynamicToolCallbacks {
  readonly execute: DurableDynamicCallbackReference;
  readonly approvalKey?: DurableDynamicCallbackReference;
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
  approvalKey: StampedDurableDynamicCallback;
  approvalRequest: StampedDurableDynamicCallback;
  approvalResponse: StampedDurableDynamicCallback;
  toModelOutput: StampedDurableDynamicCallback;
}>;

const STAMPED_CALLBACK = Symbol.for("eve:durable-dynamic-callback");
export const DURABLE_DYNAMIC_TOOL_CALLBACKS = Symbol.for("eve:durable-dynamic-tool-callbacks");

const REGISTRY = Symbol.for("eve:scoped-dynamic-tool-callbacks");
const MAX_CACHED_SESSIONS = 1_024;

export type DynamicToolCallbackScope = "session" | "turn" | "step";

export interface DynamicToolCallbackOwner {
  readonly sessionId: string;
  readonly scope: DynamicToolCallbackScope;
  readonly resolverSlug: string;
  readonly entryKey: string;
  readonly name: string;
}

type Registry = Map<string, Map<string, DurableDynamicCallbackFn>>;

function getRegistry(): Registry {
  const global = globalThis as Record<symbol, Registry | undefined>;
  return (global[REGISTRY] ??= new Map());
}

function getSessionBindings(sessionId: string): Map<string, DurableDynamicCallbackFn> | undefined {
  const registry = getRegistry();
  const bindings = registry.get(sessionId);
  if (bindings !== undefined) {
    registry.delete(sessionId);
    registry.set(sessionId, bindings);
  }
  return bindings;
}

function callbackKey(owner: DynamicToolCallbackOwner, phase: DurableDynamicCallbackPhase): string {
  return JSON.stringify([owner.scope, owner.resolverSlug, owner.entryKey, owner.name, phase]);
}

/** Re-resolution updates only the same session's resolver and lifecycle scope. */
export function registerDurableDynamicCallback(input: {
  readonly callback: DurableDynamicCallbackFn;
  readonly phase: DurableDynamicCallbackPhase;
  readonly owner: DynamicToolCallbackOwner;
}): void {
  const registry = getRegistry();
  let bindings = getSessionBindings(input.owner.sessionId);
  if (bindings === undefined) {
    bindings = new Map();
    registry.set(input.owner.sessionId, bindings);
    // Eviction behaves like a process restart: missing bindings must rebind or fail closed.
    if (registry.size > MAX_CACHED_SESSIONS) registry.delete(registry.keys().next().value!);
  }
  bindings.set(callbackKey(input.owner, input.phase), input.callback);
}

export function lookupDurableDynamicCallback(
  owner: DynamicToolCallbackOwner,
  phase: DurableDynamicCallbackPhase,
): DurableDynamicCallbackFn | undefined {
  return getSessionBindings(owner.sessionId)?.get(callbackKey(owner, phase));
}

/** Discards completed sessions or a resolver's previous result before replacement. */
export function clearDurableDynamicCallbacks(
  sessionId: string,
  resolver?: { readonly scope: DynamicToolCallbackScope; readonly resolverSlug: string },
): void {
  if (resolver === undefined) {
    getRegistry().delete(sessionId);
    return;
  }
  const bindings = getSessionBindings(sessionId);
  if (bindings === undefined) return;
  const prefix = JSON.stringify([resolver.scope, resolver.resolverSlug]).slice(0, -1) + ",";
  for (const key of bindings.keys()) {
    if (key.startsWith(prefix)) bindings.delete(key);
  }
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
  metadata: readonly {
    callbacks: DurableDynamicToolCallbacks;
    name: string;
    resolverSlug: string;
    entryKey: string;
  }[],
  scope: Pick<DynamicToolCallbackOwner, "sessionId" | "scope">,
): boolean {
  return metadata.some((entry) =>
    (Object.keys(entry.callbacks) as DurableDynamicCallbackPhase[]).some(
      (phase) => lookupDurableDynamicCallback({ ...entry, ...scope }, phase) === undefined,
    ),
  );
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
  readonly approval?: Approval<never>;
  readonly approvalKey?: (...args: never[]) => unknown;
  readonly execute: (...args: never[]) => unknown;
  readonly toModelOutput?: (...args: never[]) => unknown;
}): LiveDurableDynamicToolCallbacks {
  const approvalRequest =
    input.approval === undefined
      ? undefined
      : readDurableDynamicCallback(resolveApprovalPolicy(input.approval));
  const approvalResponse =
    input.approval === undefined || typeof input.approval === "function"
      ? undefined
      : readDurableDynamicCallback(input.approval.response);

  const approvalKey = readDurableDynamicCallback(input.approvalKey);
  const execute = readDurableDynamicCallback(input.execute);
  const toModelOutput = readDurableDynamicCallback(input.toModelOutput);
  const callbacks: LiveDurableDynamicToolCallbacks = {};
  if (execute !== undefined) callbacks.execute = execute;
  if (approvalKey !== undefined) callbacks.approvalKey = approvalKey;
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
