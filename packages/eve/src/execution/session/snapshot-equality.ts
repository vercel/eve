import { isDeepStrictEqual } from "node:util";

/** Native structural equality does not compare the bytes hidden inside Blob or File. */
export async function equalSnapshot(left: unknown, right: unknown): Promise<boolean> {
  if (!isDeepStrictEqual(left, right)) return false;
  const leftBlobs = collectBlobs(left);
  const rightBlobs = collectBlobs(right);
  if (leftBlobs.length !== rightBlobs.length) return false;
  for (let index = 0; index < leftBlobs.length; index++) {
    const [leftBytes, rightBytes] = await Promise.all([
      leftBlobs[index]!.arrayBuffer(),
      rightBlobs[index]!.arrayBuffer(),
    ]);
    if (!isDeepStrictEqual(leftBytes, rightBytes)) return false;
  }
  return true;
}

function collectBlobs(value: unknown): Blob[] {
  const seen = new Set<object>();
  const blobs: Blob[] = [];
  const visit = (current: unknown): void => {
    if (typeof current !== "object" || current === null || seen.has(current)) return;
    seen.add(current);
    if (current instanceof Blob) blobs.push(current);
    else if (current instanceof Map) {
      for (const [key, value] of current) {
        visit(key);
        visit(value);
      }
    } else if (current instanceof Set) {
      for (const value of current) visit(value);
    } else {
      for (const key of Reflect.ownKeys(current)) visit(Reflect.get(current, key));
    }
  };
  visit(value);
  return blobs;
}
