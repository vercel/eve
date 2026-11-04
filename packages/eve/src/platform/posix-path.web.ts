// POSIX path rules where there's no `node:path`. `posix-path.ts` is the Node twin, which this
// matches; the package's `#platform/*` imports pick one by the `node` condition. There's no
// working directory here, so a path with no absolute segment resolves against the root.

/** Whether `path` is absolute. */
export function isAbsolutePosix(path: string): boolean {
  return path.startsWith("/");
}

/** `segments` resolved right to left into one normalized absolute path. */
export function resolvePosix(...segments: string[]): string {
  let resolved = "";
  for (let i = segments.length - 1; i >= 0 && !resolved.startsWith("/"); i--) {
    const segment = segments[i]!;
    if (segment.length === 0) continue;
    resolved = resolved.length === 0 ? segment : `${segment}/${resolved}`;
  }
  const parts: string[] = [];
  for (const part of resolved.split("/")) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}
