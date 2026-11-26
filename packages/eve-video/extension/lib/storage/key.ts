function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function normalizeStorageKey(key: string): string {
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new TypeError("Video storage key cannot be empty.");
  }
  if (key.startsWith("/") || key.endsWith("/")) {
    throw new TypeError(
      `Invalid video storage key "${key}": leading or trailing "/" is not allowed.`,
    );
  }
  if (key.includes("\\") || hasControlCharacters(key)) {
    throw new TypeError(`Invalid video storage key "${key}": contains forbidden characters.`);
  }
  const segments = key.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment.includes("..")) {
      throw new TypeError(`Invalid video storage key "${key}": contains an invalid path segment.`);
    }
  }
  return segments.join("/");
}
