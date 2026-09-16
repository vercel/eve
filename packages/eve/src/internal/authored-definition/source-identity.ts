export type DefinitionSourceEntry =
  | { readonly kind: "connection"; readonly logicalPath?: string; readonly name: string }
  | { readonly kind: "tool"; readonly logicalPath?: string; readonly name: string };

type AmbiguousDefinitionSourceEntry = { readonly kind: "ambiguous" };
type RegisteredDefinitionSource = DefinitionSourceEntry | AmbiguousDefinitionSourceEntry;

const DEFINITION_KEY = Symbol.for("eve.definition-source-key");
const REGISTRY_SYMBOL = Symbol.for("eve.definition-source-registry");

type RegistryGlobal = typeof globalThis & {
  [REGISTRY_SYMBOL]?: Map<string, RegisteredDefinitionSource>;
};

const registryContainer = globalThis as RegistryGlobal;
registryContainer[REGISTRY_SYMBOL] ??= new Map();
const definitionSourceRegistry = registryContainer[REGISTRY_SYMBOL];

export function stampDefinitionKey(definition: object, key: string): void {
  Object.defineProperty(definition, DEFINITION_KEY, { configurable: true, value: key });
}

export function registerDefinitionSource(key: string, entry: DefinitionSourceEntry): void {
  const existing = definitionSourceRegistry.get(key);
  if (existing !== undefined && !sameDefinitionSourceEntry(existing, entry)) {
    if (existing.kind !== "ambiguous") {
      console.warn(
        [
          `eve could not assign a unique toolResultFrom identity for ${JSON.stringify(key)}.`,
          `Conflicting definitions: ${formatDefinitionSourceForWarning(existing)} and ${formatDefinitionSourceForWarning(entry)}.`,
          "Multiple authored definitions share that fallback identity, so only lookups that fall back to it will not match.",
          "Definitions loaded by eve resolve through their source identity, so use the original definition object loaded by eve.",
        ].join(" "),
      );
    }
    definitionSourceRegistry.set(key, { kind: "ambiguous" });
    return;
  }
  definitionSourceRegistry.set(key, entry);
}

export function readDefinitionSource(definition: object): RegisteredDefinitionSource | undefined {
  const key = readDefinitionKey(definition);
  return key === undefined ? undefined : definitionSourceRegistry.get(key);
}

function readDefinitionKey(definition: object): string | undefined {
  if (DEFINITION_KEY in definition) {
    return (definition as Record<symbol, string>)[DEFINITION_KEY];
  }
  return undefined;
}

function sameDefinitionSourceEntry(
  a: RegisteredDefinitionSource,
  b: DefinitionSourceEntry,
): boolean {
  if (a.kind !== b.kind) return false;
  return a.name === b.name;
}

function formatDefinitionSourceForWarning(entry: DefinitionSourceEntry): string {
  if (entry.logicalPath === undefined) {
    return `${entry.kind} "${entry.name}"`;
  }
  return `${entry.kind} "${entry.name}" from "${entry.logicalPath}"`;
}
