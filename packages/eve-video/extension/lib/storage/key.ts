export function normalizeStorageKey(key: string): string {
  if (typeof key !== "string" || !key.trim())
    throw new TypeError("Video storage key cannot be empty.");
  if (key.startsWith("/") || key.endsWith("/"))
    throw new TypeError(`Invalid video storage key "${key}".`);
  for (let i = 0; i < key.length; i += 1) {
    const c = key.charCodeAt(i);
    if (key[i] === "\\" || c <= 0x1f || c === 0x7f)
      throw new TypeError(`Invalid video storage key "${key}".`);
  }
  const segs = key.split("/");
  if (segs.some((s) => !s || s === "." || s.includes("..")))
    throw new TypeError(`Invalid video storage key "${key}".`);
  return segs.join("/");
}
