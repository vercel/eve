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

const RESOLVED = new WeakMap<object, Map<string, ScheduleCollectionSourceIdentity>>();

/**
 * Remembers which application resolved the module's own export. A module that two applications resolve is stamped on a copy
 * per application, so the reference an author imports carries no stamp itself; `readScheduleCollectionSource` finds the
 * identity through this record when exactly one application resolved the module, and finds none when it is ambiguous.
 */
export function recordResolvedScheduleCollection(
  authored: object,
  identity: ScheduleCollectionSourceIdentity,
): void {
  const identities = RESOLVED.get(authored) ?? new Map<string, ScheduleCollectionSourceIdentity>();
  identities.set(`${identity.application}\0${identity.sourceId}`, Object.freeze({ ...identity }));
  RESOLVED.set(authored, identities);
}

export function readScheduleCollectionSource(
  value: object,
): ScheduleCollectionSourceIdentity | undefined {
  const stamped = Reflect.get(value, SCHEDULE_COLLECTION_SOURCE) as
    | ScheduleCollectionSourceIdentity
    | undefined;
  if (stamped !== undefined) return stamped;
  const resolved = RESOLVED.get(value);
  return resolved?.size === 1 ? [...resolved.values()][0] : undefined;
}

export function isScheduleCollectionDefinition(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, SCHEDULE_COLLECTION_DEFINITION_BRAND) === true
  );
}
