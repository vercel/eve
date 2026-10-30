// `rolldown/filter`'s helpers, which eve cannot import while Rolldown is only
// Nitro's dependency. Rolldown tests RegExp id filters against ids with `/`
// separators on every platform.

const ESCAPE_REGEX_RE = /[-/\\^$*+?.()|[\]{}]/g;

function escapeRegex(value: string): string {
  return value.replace(ESCAPE_REGEX_RE, "\\$&");
}

export function exactRegex(value: string, flags?: string): RegExp {
  return new RegExp(`^${escapeRegex(value)}$`, flags);
}

export function prefixRegex(value: string, flags?: string): RegExp {
  return new RegExp(`^${escapeRegex(value)}`, flags);
}

/**
 * Matches any of `paths` as a module id, ignoring a query or hash suffix.
 * Windows paths compare case-insensitively, as the filesystem does.
 */
export function pathsRegex(paths: readonly string[]): RegExp {
  const alternatives = paths.map((path) => escapeRegex(path.replaceAll("\\", "/")));
  return new RegExp(
    `^(?:${alternatives.join("|")})(?:[?#].*)?$`,
    process.platform === "win32" ? "i" : undefined,
  );
}
