const ESCAPE_REGEX_RE = /[-/\\^$*+?.()|[\]{}]/g;

export function escapeRegex(value: string): string {
  return value.replace(ESCAPE_REGEX_RE, "\\$&");
}

export function exactRegex(value: string, flags?: string): RegExp {
  return new RegExp(`^${escapeRegex(value)}$`, flags);
}

export function prefixRegex(value: string, flags?: string): RegExp {
  return new RegExp(`^${escapeRegex(value)}`, flags);
}

export function pathsRegex(
  paths: readonly string[],
  platform: NodeJS.Platform = process.platform,
): RegExp {
  const alternatives = paths.map((path) => escapeRegex(path.replaceAll("\\", "/")));
  return new RegExp(
    `^(?:${alternatives.join("|")})(?:[?#].*)?$`,
    platform === "win32" ? "i" : undefined,
  );
}
