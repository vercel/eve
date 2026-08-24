import { AsyncLocalStorage } from "node:async_hooks";

import type { CompiledAgentManifest } from "#compiler/manifest.js";
import {
  createCompiledExtensionRegistrationIndex,
  extensionRegistrationForSourceId,
  type CompiledExtensionRegistrationIndex,
} from "#compiler/extension-registrations.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { bindExtensionRegistration } from "#public/definitions/extension.js";

const EXTENSION_REGISTRATION_STORAGE = Symbol.for("eve.extension-registration-storage");
const indexes = new WeakMap<CompiledModuleMap, CompiledExtensionRegistrationIndex>();
const emptyIndex: CompiledExtensionRegistrationIndex = {
  agentRootByNodeId: new Map(),
  byMountSourceIdByNodeId: new Map(),
  byNamespaceByNodeId: new Map(),
  registrations: [],
};

function registrationStorage(): AsyncLocalStorage<string> {
  const container = globalThis as Record<symbol, unknown>;
  let storage = container[EXTENSION_REGISTRATION_STORAGE] as AsyncLocalStorage<string> | undefined;
  if (storage === undefined) {
    storage = new AsyncLocalStorage<string>();
    container[EXTENSION_REGISTRATION_STORAGE] = storage;
  }
  return storage;
}

/** Registers every evaluated mount export before authored definitions resolve. */
export function registerExtensionConfigs(
  manifest: CompiledAgentManifest,
  moduleMap: CompiledModuleMap,
): void {
  const index = createCompiledExtensionRegistrationIndex(manifest);
  indexes.set(moduleMap, index);

  for (const [nodeId, registrations] of index.byMountSourceIdByNodeId) {
    for (const [sourceId, registration] of registrations) {
      const mountNamespace = moduleMap.nodes[nodeId]?.modules[sourceId];
      bindExtensionRegistration(registration.id, mountNamespace?.default);
    }
  }
}

/** Runs an authored operation under the registration that owns its source id. */
export function runWithExtensionRegistration<T>(input: {
  readonly moduleMap: CompiledModuleMap;
  readonly nodeId: string;
  readonly sourceId: string;
  readonly logicalPath: string;
  readonly operation: () => T;
}): T {
  const registration = extensionRegistrationForSourceId(
    input.sourceId,
    input.logicalPath,
    input.nodeId,
    indexes.get(input.moduleMap) ?? emptyIndex,
  );
  return registration === undefined
    ? registrationStorage().exit(input.operation)
    : registrationStorage().run(registration.id, input.operation);
}

/** Wraps functions nested in authored definition objects with their registration. */
export function wrapExtensionCallbacks<T>(input: {
  readonly moduleMap: CompiledModuleMap;
  readonly nodeId: string;
  readonly sourceId: string;
  readonly logicalPath: string;
  readonly value: T;
}): T {
  const registration = extensionRegistrationForSourceId(
    input.sourceId,
    input.logicalPath,
    input.nodeId,
    indexes.get(input.moduleMap) ?? emptyIndex,
  );
  if (registration === undefined) return input.value;
  return wrapValue(input.value, registration.id, new WeakMap()) as T;
}

function wrapValue(
  value: unknown,
  registrationId: string,
  seen: WeakMap<object, unknown>,
): unknown {
  if (typeof value === "function") {
    const cached = seen.get(value);
    if (cached !== undefined) return cached;
    const wrapped = new Proxy(value, {
      apply(target, thisArg, args) {
        return registrationStorage().run(registrationId, () => {
          const result = Reflect.apply(target, thisArg, args);
          if (isPromiseLike(result)) {
            return Promise.resolve(result).then((resolved) =>
              wrapValue(resolved, registrationId, seen),
            );
          }
          return wrapValue(result, registrationId, seen);
        });
      },
    });
    seen.set(value, wrapped);
    return wrapped;
  }

  if (typeof value !== "object" || value === null) return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) return value;

  const cached = seen.get(value);
  if (cached !== undefined) return cached;
  const wrapped: Record<PropertyKey, unknown> | unknown[] = Array.isArray(value)
    ? []
    : Object.create(prototype);
  seen.set(value, wrapped);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    if ("value" in descriptor) {
      descriptor.value = wrapValue(descriptor.value, registrationId, seen);
    }
    if (descriptor.get !== undefined) {
      descriptor.get = wrapValue(descriptor.get, registrationId, seen) as () => unknown;
    }
    if (descriptor.set !== undefined) {
      descriptor.set = wrapValue(descriptor.set, registrationId, seen) as (value: unknown) => void;
    }
    Object.defineProperty(wrapped, key, descriptor);
  }
  if (Object.isFrozen(value)) Object.freeze(wrapped);
  else if (Object.isSealed(value)) Object.seal(wrapped);
  else if (!Object.isExtensible(value)) Object.preventExtensions(wrapped);
  return wrapped;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}
