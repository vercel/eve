import type { FilterExpression, TopLevelFilterExpression } from "rolldown/filter";

export type { FilterExpression };

const ESCAPE_REGEX_RE = /[-/\\^$*+?.()|[\]{}]/g;
const EITHER_SEPARATOR = "[\\\\/]";

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

export function pathSource(path: string): string {
  return path.split(/[\\/]/).map(escapeRegex).join(EITHER_SEPARATOR);
}

export function packageModulesRegex(packageRoot: string): RegExp {
  const nodeModules = `${EITHER_SEPARATOR}node_modules${EITHER_SEPARATOR}`;
  return new RegExp(
    `^${pathSource(packageRoot)}(?!.*${nodeModules})${EITHER_SEPARATOR}`,
    process.platform === "win32" ? "i" : undefined,
  );
}

export function include(expr: FilterExpression): TopLevelFilterExpression {
  return { kind: "include", expr };
}

export function exclude(expr: FilterExpression): TopLevelFilterExpression {
  return { kind: "exclude", expr };
}

export function or(...args: FilterExpression[]): FilterExpression {
  return { kind: "or", args };
}

export function not(expr: FilterExpression): FilterExpression {
  return { kind: "not", expr };
}

export function id(pattern: RegExp): FilterExpression {
  return { kind: "id", pattern, params: {} };
}

export function importerId(pattern: RegExp): FilterExpression {
  return { kind: "importerId", pattern, params: {} };
}

export function resolveIdFilter(
  specifier: RegExp,
  importer?: FilterExpression,
): { id: RegExp } | TopLevelFilterExpression[] {
  return importer === undefined
    ? { id: specifier }
    : [include({ kind: "and", args: [id(specifier), importer] })];
}
