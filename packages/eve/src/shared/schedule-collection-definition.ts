export const SCHEDULE_COLLECTION_DEFINITION_BRAND = Symbol.for(
  "eve:schedule-collection-definition",
);
export const SCHEDULE_COLLECTION_SOURCE = Symbol.for("eve:schedule-collection-source");

export interface ScheduleCollectionSourceIdentity {
  readonly application: string;
  readonly collection: string;
  readonly logicalPath: string;
  readonly sourceId: string;
}

export function stampScheduleCollectionSource(
  value: object,
  identity: ScheduleCollectionSourceIdentity,
): void {
  const existing = readScheduleCollectionSource(value);
  if (existing !== undefined) {
    if (
      existing.application !== identity.application ||
      existing.collection !== identity.collection ||
      existing.logicalPath !== identity.logicalPath ||
      existing.sourceId !== identity.sourceId
    ) {
      throw new Error("Schedule collection source identity does not match its compiled module.");
    }
    return;
  }
  Object.defineProperty(value, SCHEDULE_COLLECTION_SOURCE, {
    configurable: false,
    enumerable: false,
    value: Object.freeze({ ...identity }),
  });
}

export function readScheduleCollectionSource(
  value: object,
): ScheduleCollectionSourceIdentity | undefined {
  return Reflect.get(value, SCHEDULE_COLLECTION_SOURCE) as
    | ScheduleCollectionSourceIdentity
    | undefined;
}

export function isScheduleCollectionDefinition(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, SCHEDULE_COLLECTION_DEFINITION_BRAND) === true
  );
}
