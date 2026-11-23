const INHERIT_PARENT_MODEL: unique symbol = Symbol.for("eve.inherit-parent-model");

export function inheritParentModel<TDefinition extends object>(
  definition: TDefinition,
): TDefinition {
  Object.defineProperty(definition, INHERIT_PARENT_MODEL, { configurable: true, value: true });
  return definition;
}

export function inheritsParentModel(definition: unknown): boolean {
  return (
    typeof definition === "object" &&
    definition !== null &&
    Reflect.get(definition, INHERIT_PARENT_MODEL) === true
  );
}
