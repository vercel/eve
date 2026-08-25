import type { Approval } from "#public/definitions/approval.js";
import { resolveApprovalPolicy } from "#public/definitions/approval.js";
import type { JsonObject } from "#shared/json.js";

export type DurableDynamicCallbackPhase =
  | "approvalRequest"
  | "approvalResponse"
  | "execute"
  | "toModelOutput";

export type DurableDynamicCallbackFn = (closure: JsonObject, ...args: never[]) => unknown;

/**
 * Persisted binding for one callback phase. The registration key distinguishes
 * resolver registrations without coupling durable identity to source code.
 */
export interface DurableDynamicCallbackReference {
  readonly closure: JsonObject;
  readonly registrationKey?: string;
}

export interface DurableDynamicToolCallbacks {
  readonly execute: DurableDynamicCallbackReference;
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
  approvalRequest: StampedDurableDynamicCallback;
  approvalResponse: StampedDurableDynamicCallback;
  toModelOutput: StampedDurableDynamicCallback;
}>;

const STAMPED_CALLBACK = Symbol.for("eve:durable-dynamic-callback");
export const DURABLE_DYNAMIC_TOOL_CALLBACKS = Symbol.for("eve:durable-dynamic-tool-callbacks");

const REGISTRY = Symbol.for("eve:dynamic-tool-callbacks:v2");
const OWNED_REGISTRIES = Symbol.for("eve:dynamic-tool-callback-registries:v2");

const LEGACY_REGISTRATION = Symbol.for("eve:dynamic-tool-callbacks:legacy-registration");

type RegistrationKey = string | typeof LEGACY_REGISTRATION;
type PhaseRegistry = Map<RegistrationKey, DurableDynamicCallbackFn>;
type Registry = Map<string, Map<DurableDynamicCallbackPhase, PhaseRegistry>>;

function getRegistry(): Registry {
  const global = globalThis as Record<symbol, Registry | undefined>;
  const existing = global[REGISTRY];
  if (existing !== undefined) return existing;

  const registry: Registry = new Map();
  global[REGISTRY] = registry;
  return registry;
}

function getOwnedRegistries(): Map<string, Registry> {
  const global = globalThis as Record<symbol, Map<string, Registry> | undefined>;
  const existing = global[OWNED_REGISTRIES];
  if (existing !== undefined) return existing;

  const registries = new Map<string, Registry>();
  global[OWNED_REGISTRIES] = registries;
  return registries;
}

function getRegistryForOwner(owner: string | undefined): Registry {
  if (owner === undefined) return getRegistry();
  const registries = getOwnedRegistries();
  const existing = registries.get(owner);
  if (existing !== undefined) return existing;

  const registry: Registry = new Map();
  registries.set(owner, registry);
  return registry;
}

function lookupInRegistry(
  registry: Registry,
  toolName: string,
  phase: DurableDynamicCallbackPhase,
  registrationKey: string | undefined,
): DurableDynamicCallbackFn | undefined {
  const registrations = registry.get(toolName)?.get(phase);
  if (registrations === undefined) return undefined;
  if (registrationKey !== undefined) return registrations.get(registrationKey);
  const legacy = registrations.get(LEGACY_REGISTRATION);
  if (legacy !== undefined) return legacy;
  return registrations.size === 1 ? registrations.values().next().value : undefined;
}

/** Releases callback registrations after a terminal session completion. */
export function clearDurableDynamicCallbacksForSession(sessionId: string): void {
  getOwnedRegistries().delete(sessionId);
}

/**
 * Binds the current implementation of one tool callback phase. Re-resolution
 * of the same registration replaces its binding, while distinct registrations
 * remain isolated under the same tool name and phase.
 */
export function registerDurableDynamicCallback(input: {
  readonly callback: DurableDynamicCallbackFn;
  readonly owner?: string;
  readonly phase: DurableDynamicCallbackPhase;
  readonly registrationKey?: string;
  readonly toolName: string;
}): void {
  const registry = getRegistryForOwner(input.owner);
  let tools = registry.get(input.toolName);
  if (tools === undefined) {
    tools = new Map();
    registry.set(input.toolName, tools);
  }
  let registrations = tools.get(input.phase);
  if (registrations === undefined) {
    registrations = new Map();
    tools.set(input.phase, registrations);
  }
  const registrationKey = input.registrationKey ?? LEGACY_REGISTRATION;
  const existing = registrations.get(registrationKey);
  if (
    registrationKey === LEGACY_REGISTRATION &&
    existing !== undefined &&
    existing !== input.callback
  ) {
    throw new Error(
      `Dynamic tool "${input.toolName}" callback "${input.phase}" has multiple implementations ` +
        "without distinct registration keys.",
    );
  }
  registrations.set(registrationKey, input.callback);
}

export function lookupDurableDynamicCallback(
  toolName: string,
  phase: DurableDynamicCallbackPhase,
  registrationKey?: string,
  owner?: string,
): DurableDynamicCallbackFn | undefined {
  if (owner !== undefined) {
    const ownedRegistry = getOwnedRegistries().get(owner);
    return ownedRegistry === undefined
      ? undefined
      : lookupInRegistry(ownedRegistry, toolName, phase, registrationKey);
  }
  return lookupInRegistry(getRegistry(), toolName, phase, registrationKey);
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
  owner?: string,
): boolean {
  return metadata.some((entry) =>
    (Object.keys(entry.callbacks) as DurableDynamicCallbackPhase[]).some((phase) => {
      const reference = entry.callbacks[phase];
      return (
        reference?.registrationKey === undefined ||
        lookupDurableDynamicCallback(entry.name, phase, reference.registrationKey, owner) ===
          undefined
      );
    }),
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

  const execute = readDurableDynamicCallback(input.execute);
  const toModelOutput = readDurableDynamicCallback(input.toModelOutput);
  const callbacks: LiveDurableDynamicToolCallbacks = {};
  if (execute !== undefined) callbacks.execute = execute;
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
