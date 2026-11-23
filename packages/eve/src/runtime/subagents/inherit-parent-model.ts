const inheriting = new WeakSet<object>();

export function inheritParentModel<TDefinition extends object>(
  definition: TDefinition,
): TDefinition {
  inheriting.add(definition);
  return definition;
}

export function inheritsParentModel(definition: unknown): boolean {
  return typeof definition === "object" && definition !== null && inheriting.has(definition);
}
