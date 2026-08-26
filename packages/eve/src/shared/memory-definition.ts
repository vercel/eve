export const MEMORY_DEFINITION_BRAND = Symbol.for("eve:memory-definition");

export function isMemoryDefinition(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, MEMORY_DEFINITION_BRAND) === true
  );
}
