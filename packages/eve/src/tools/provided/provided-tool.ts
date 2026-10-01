const EVE_PROVIDED_TOOL = Symbol.for("eve.providedTool");

/**
 * Marks a tool definition eve provides, so it runs as usual in an eval session
 * with tool stubs, including when an app re-exports it from `agent/tools/`.
 * Tool resolution copies the mark to the resolved tool's `provided` field.
 */
export function markProvidedTool<TDefinition extends object>(definition: TDefinition): TDefinition {
  Object.defineProperty(definition, EVE_PROVIDED_TOOL, { enumerable: true, value: true });
  return definition;
}

/** Reports whether `definition` was marked by {@link markProvidedTool}. */
export function isProvidedTool(definition: object): boolean {
  return Reflect.get(definition, EVE_PROVIDED_TOOL) === true;
}
