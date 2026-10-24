export const COMPACTION_DEFINITION_BRAND = Symbol.for("eve:compaction-definition");

export function isCompactionDefinition(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, COMPACTION_DEFINITION_BRAND) === true
  );
}
