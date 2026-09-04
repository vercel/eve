import { isDeepStrictEqual } from "node:util";

/** Native structural equality does not compare the bytes hidden inside Blob or File. */
export async function equalSnapshot(left: unknown, right: unknown): Promise<boolean> {
  if (!isDeepStrictEqual(left, right)) return false;
  const pending: [unknown, unknown][] = [[left, right]];
  const seen = new WeakMap<object, WeakSet<object>>();
  while (pending.length > 0) {
    const [a, b] = pending.pop()!;
    if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) continue;
    if (seen.get(a)?.has(b)) continue;
    let paired = seen.get(a);
    if (paired === undefined) {
      paired = new WeakSet();
      seen.set(a, paired);
    }
    paired.add(b);
    if (a instanceof Blob && b instanceof Blob) {
      const [aBytes, bBytes] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
      if (!isDeepStrictEqual(aBytes, bBytes)) return false;
    } else if (a instanceof Map && b instanceof Map) {
      const aEntries = [...a];
      const bEntries = [...b];
      // Iteration order is observable; matching it also pairs hidden Blob bytes
      // with the same keys instead of unrelated values in an unordered map.
      if (!isDeepStrictEqual(aEntries, bEntries)) return false;
      pending.push([aEntries, bEntries]);
    } else if (a instanceof Set && b instanceof Set) {
      const aValues = [...a];
      const bValues = [...b];
      if (!isDeepStrictEqual(aValues, bValues)) return false;
      pending.push([aValues, bValues]);
    } else {
      for (const key of Reflect.ownKeys(a))
        pending.push([Reflect.get(a, key), Reflect.get(b, key)]);
    }
  }
  return true;
}
