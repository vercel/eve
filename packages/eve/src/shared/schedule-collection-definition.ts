export const SCHEDULE_COLLECTION_DEFINITION_BRAND = Symbol.for(
  "eve:schedule-collection-definition",
);

export function isScheduleCollectionDefinition(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, SCHEDULE_COLLECTION_DEFINITION_BRAND) === true
  );
}
