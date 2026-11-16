// Hook filter helpers in the shape of `rolldown/filter`'s, kept here so plugin
// modules never load Rolldown. Rolldown tests RegExp id filters against ids
// with `/` separators on every platform.

import type { FilterExpression, TopLevelFilterExpression } from "rolldown/filter";

export type { FilterExpression };

const ESCAPE_REGEX_RE = /[-/\\^$*+?.()|[\]{}]/g;
// A plain literal rather than `String.raw`: hosted bundles import this module, and a bundler
// keeps a tagged template at module scope because it cannot prove the call pure.
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

/**
 * Matches any of `paths` as a module id, ignoring a query or hash suffix.
 * Windows paths compare case-insensitively, as the filesystem does.
 */
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

/**
 * RegExp source for `path` written with either separator: a filter sees ids
 * with `/` separators, and a handler sees them as the platform writes them.
 */
export function pathSource(path: string): string {
  return path.split(/[\\/]/).map(escapeRegex).join(EITHER_SEPARATOR);
}

/**
 * Matches the ids of a package's own modules: those inside `packageRoot` and outside every
 * `node_modules` below it, where other packages are installed. Windows paths compare
 * case-insensitively, as the filesystem does.
 */
export function packageModulesRegex(packageRoot: string): RegExp {
  const nodeModules = `${EITHER_SEPARATOR}node_modules${EITHER_SEPARATOR}`;
  return new RegExp(
    `^${pathSource(packageRoot)}(?!.*${nodeModules})${EITHER_SEPARATOR}`,
    process.platform === "win32" ? "i" : undefined,
  );
}

// Filter expressions are plain data that Rolldown evaluates natively: a call
// they reject never crosses into JavaScript.

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

/** In `resolveId`, the id is the import specifier. */
export function id(pattern: RegExp): FilterExpression {
  return { kind: "id", pattern, params: {} };
}

/** Only for `resolveId`. Never matches an entry module, which has no importer. */
export function importerId(pattern: RegExp): FilterExpression {
  return { kind: "importerId", pattern, params: {} };
}

/** Admits `resolveId` calls for specifiers matching `specifier`, from importers `importer` admits. */
export function resolveIdFilter(
  specifier: RegExp,
  importer?: FilterExpression,
): { id: RegExp } | TopLevelFilterExpression[] {
  return importer === undefined
    ? { id: specifier }
    : [include({ kind: "and", args: [id(specifier), importer] })];
}
