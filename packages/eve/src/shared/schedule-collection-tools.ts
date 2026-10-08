export function scheduleCollectionToolPrefix(collection: string): string {
  return `schedule__${collection.replaceAll("/", "-")}`;
}
