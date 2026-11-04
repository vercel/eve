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

// `basenamePosix`, `dirnamePosix` and `extnamePosix` follow Node's `path.posix` algorithms step
// for step (lib/path.js, MIT), since callers compare their results with paths Node built.
const SLASH = 47;
const DOT = 46;

/** The last segment of `path`, without `suffix` when it ends with it. */
export function basenamePosix(path: string, suffix?: string): string {
  let start = 0;
  let end = -1;
  let matchedSlash = true;
  if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
    if (suffix === path) return "";
    let extIdx = suffix.length - 1;
    let firstNonSlashEnd = -1;
    for (let i = path.length - 1; i >= 0; --i) {
      const code = path.charCodeAt(i);
      if (code === SLASH) {
        if (!matchedSlash) {
          start = i + 1;
          break;
        }
      } else {
        if (firstNonSlashEnd === -1) {
          matchedSlash = false;
          firstNonSlashEnd = i + 1;
        }
        if (extIdx >= 0) {
          if (code === suffix.charCodeAt(extIdx)) {
            if (--extIdx === -1) end = i;
          } else {
            extIdx = -1;
            end = firstNonSlashEnd;
          }
        }
      }
    }
    if (start === end) end = firstNonSlashEnd;
    else if (end === -1) end = path.length;
    return path.slice(start, end);
  }
  for (let i = path.length - 1; i >= 0; --i) {
    if (path.charCodeAt(i) === SLASH) {
      if (!matchedSlash) {
        start = i + 1;
        break;
      }
    } else if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
  }
  return end === -1 ? "" : path.slice(start, end);
}

/** `path` without its last segment. */
export function dirnamePosix(path: string): string {
  if (path.length === 0) return ".";
  const hasRoot = path.charCodeAt(0) === SLASH;
  let end = -1;
  let matchedSlash = true;
  for (let i = path.length - 1; i >= 1; --i) {
    if (path.charCodeAt(i) === SLASH) {
      if (!matchedSlash) {
        end = i;
        break;
      }
    } else {
      matchedSlash = false;
    }
  }
  if (end === -1) return hasRoot ? "/" : ".";
  if (hasRoot && end === 1) return "//";
  return path.slice(0, end);
}

/** The extension of `path`'s last segment, from its last `.`, or "". */
export function extnamePosix(path: string): string {
  let startDot = -1;
  let startPart = 0;
  let end = -1;
  let matchedSlash = true;
  let preDotState = 0;
  for (let i = path.length - 1; i >= 0; --i) {
    const code = path.charCodeAt(i);
    if (code === SLASH) {
      if (!matchedSlash) {
        startPart = i + 1;
        break;
      }
      continue;
    }
    if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
    if (code === DOT) {
      if (startDot === -1) startDot = i;
      else if (preDotState !== 1) preDotState = 1;
    } else if (startDot !== -1) {
      preDotState = -1;
    }
  }
  if (
    startDot === -1 ||
    end === -1 ||
    preDotState === 0 ||
    (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
  ) {
    return "";
  }
  return path.slice(startDot, end);
}

/** `segments` joined and normalized. */
export function joinPosix(...segments: string[]): string {
  const joined = segments.filter((segment) => segment.length > 0).join("/");
  return joined.length === 0 ? "." : normalizePosix(joined);
}

/** `path` normalized: `.` and `..` segments and repeated slashes resolved. */
export function normalizePosix(path: string): string {
  if (path.length === 0) return ".";
  const absolute = path.startsWith("/");
  const trailingSlash = path.endsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part.length === 0 || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
    // Above the root of a relative path, `..` stays; above `/`, it's dropped.
    else if (!absolute) parts.push(part);
  }
  const normalized = parts.join("/");
  if (normalized.length === 0) return absolute ? "/" : trailingSlash ? "./" : ".";
  return `${absolute ? "/" : ""}${normalized}${trailingSlash ? "/" : ""}`;
}
