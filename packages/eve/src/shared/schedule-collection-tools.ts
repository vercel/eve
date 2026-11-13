export function scheduleCollectionToolPrefix(collection: string): string {
  return `schedule__${collection.replaceAll("/", "-")}`;
}

/**
 * The tool file slot a collection's tools take. The named scopes of one definition share the
 * slot its name gives.
 */
export function scheduleCollectionToolSlot(collection: {
  readonly name: string;
  readonly namedScope?: { readonly definition: string };
}): string {
  return scheduleCollectionToolPrefix(collection.namedScope?.definition ?? collection.name);
}
