type DefinitionSourceKind = "connection" | "tool";

type DefinitionSourceEntry = {
  readonly kind: DefinitionSourceKind;
  readonly logicalPath?: string;
  readonly name: string;
};

type DefinitionSource = {
  readonly kind: DefinitionSourceKind;
  readonly names: Set<string>;
};

type FallbackDefinitionSource =
  | (DefinitionSource & {
      readonly definitions: WeakSet<object>;
      readonly firstEntry: DefinitionSourceEntry;
    })
  | { readonly kind: "ambiguous" };

export type RegisteredDefinitionSource =
  | { readonly kind: DefinitionSourceKind; readonly names: ReadonlySet<string> }
  | { readonly kind: "ambiguous" };

const DEFINITION_KEY = Symbol.for("eve.definition-source-key");
const RESOLVED_REGISTRY_SYMBOL = Symbol.for("eve.resolved-definition-sources");
const FALLBACK_REGISTRY_SYMBOL = Symbol.for("eve.fallback-definition-sources");

type RegistryGlobal = typeof globalThis & {
  [RESOLVED_REGISTRY_SYMBOL]?: WeakMap<object, DefinitionSource>;
  [FALLBACK_REGISTRY_SYMBOL]?: Map<string, FallbackDefinitionSource>;
};

// Registries live on globalThis so duplicate eve module instances share them.
const registryContainer = globalThis as RegistryGlobal;
registryContainer[RESOLVED_REGISTRY_SYMBOL] ??= new WeakMap();
registryContainer[FALLBACK_REGISTRY_SYMBOL] ??= new Map();
const resolvedSources = registryContainer[RESOLVED_REGISTRY_SYMBOL];
const fallbackSources = registryContainer[FALLBACK_REGISTRY_SYMBOL];

/** Stamps the authoring-time fallback key used for copies eve never loaded. */
export function stampDefinitionKey(definition: object, key: string): void {
  Object.defineProperty(definition, DEFINITION_KEY, { configurable: true, value: key });
}

/**
 * Records a definition object eve loaded under one mounted name. The same
 * object can be mounted more than once, for example when a subagent re-exports
 * an extension tool, so every mounted name matches it.
 *
 * `fallbackKey` also lets copies with the same stamped key match. That
 * fallback is marked ambiguous when different objects with different names
 * share it.
 */
export function registerDefinitionSource(
  definition: object,
  entry: DefinitionSourceEntry,
  fallbackKey?: string,
): void {
  const resolved = resolvedSources.get(definition);
  if (resolved === undefined || resolved.kind !== entry.kind) {
    resolvedSources.set(definition, { kind: entry.kind, names: new Set([entry.name]) });
  } else {
    resolved.names.add(entry.name);
  }
  if (fallbackKey !== undefined) {
    registerFallbackSource(fallbackKey, definition, entry);
  }
}

export function readDefinitionSource(definition: object): RegisteredDefinitionSource | undefined {
  const resolved = resolvedSources.get(definition);
  if (resolved !== undefined) return resolved;
  const key = readDefinitionKey(definition);
  return key === undefined ? undefined : fallbackSources.get(key);
}

function registerFallbackSource(
  key: string,
  definition: object,
  entry: DefinitionSourceEntry,
): void {
  const existing = fallbackSources.get(key);
  if (existing === undefined) {
    fallbackSources.set(key, {
      definitions: new WeakSet([definition]),
      firstEntry: entry,
      kind: entry.kind,
      names: new Set([entry.name]),
    });
    return;
  }
  if (existing.kind === "ambiguous") return;
  if (
    existing.kind === entry.kind &&
    (existing.definitions.has(definition) || existing.names.has(entry.name))
  ) {
    existing.definitions.add(definition);
    existing.names.add(entry.name);
    return;
  }
  console.warn(
    [
      `eve could not assign a unique toolResultFrom identity for ${JSON.stringify(key)}.`,
      `Conflicting definitions: ${formatDefinitionSourceForWarning(existing.firstEntry)} and ${formatDefinitionSourceForWarning(entry)}.`,
      "Multiple authored definitions share that fallback identity, so toolResultFrom will not match through it.",
      "Use the original definition object loaded by eve so source-derived identity can be used instead.",
    ].join(" "),
  );
  fallbackSources.set(key, { kind: "ambiguous" });
}

function readDefinitionKey(definition: object): string | undefined {
  if (DEFINITION_KEY in definition) {
    return (definition as Record<symbol, string>)[DEFINITION_KEY];
  }
  return undefined;
}

function formatDefinitionSourceForWarning(entry: DefinitionSourceEntry): string {
  if (entry.logicalPath === undefined) {
    return `${entry.kind} "${entry.name}"`;
  }
  return `${entry.kind} "${entry.name}" from "${entry.logicalPath}"`;
}
