import type { CompiledModuleMap } from "#compiler/module-map.js";

const COMPILED_MODULE_MAP_IDENTITY = Symbol.for("eve.compiled-module-map-identity");

/** Attaches the compiler-owned content identity before freezing a module map. */
export function identifyCompiledModuleMap(
  moduleMap: CompiledModuleMap,
  identity: string,
): CompiledModuleMap {
  const existing = readCompiledModuleMapIdentity(moduleMap);
  if (existing !== undefined && existing !== identity) {
    throw new Error(
      `Compiled module map identity is already "${existing}" and cannot be replaced with "${identity}".`,
    );
  }
  const identified = normalizeCompiledModuleMap(moduleMap);
  Object.defineProperty(identified, COMPILED_MODULE_MAP_IDENTITY, {
    configurable: false,
    enumerable: false,
    value: identity,
    writable: false,
  });
  return Object.freeze(identified);
}

/** Clones and deeply freezes the complete module-map graph. */
export function freezeCompiledModuleMap(moduleMap: CompiledModuleMap): CompiledModuleMap {
  return Object.freeze(normalizeCompiledModuleMap(moduleMap));
}

function normalizeCompiledModuleMap(moduleMap: CompiledModuleMap): CompiledModuleMap {
  const nodes = Object.fromEntries(
    Object.entries(moduleMap.nodes).map(([nodeId, scope]) => [
      nodeId,
      Object.freeze({
        modules: Object.freeze(
          Object.fromEntries(
            Object.entries(scope.modules).map(([sourceId, namespace]) => [
              sourceId,
              Object.freeze({ ...namespace }),
            ]),
          ),
        ),
      }),
    ]),
  );
  return { nodes: Object.freeze(nodes) };
}

/** Reads the non-serializable identity attached by a trusted map constructor. */
export function readCompiledModuleMapIdentity(moduleMap: object): string | undefined {
  const identity = Reflect.get(moduleMap, COMPILED_MODULE_MAP_IDENTITY) as unknown;
  return typeof identity === "string" ? identity : undefined;
}
