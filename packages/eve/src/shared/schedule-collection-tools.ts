export function scheduleCollectionToolPrefix(collection: string): string {
  return `schedule__${collection.replaceAll("/", "-")}`;
}

export function scheduleCollectionToolSlot(collection: {
  readonly name: string;
  readonly namedScope?: { readonly definition: string };
}): string {
  return scheduleCollectionToolPrefix(collection.namedScope?.definition ?? collection.name);
}
