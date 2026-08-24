export type EveRoutePatternSegment =
  | { readonly kind: "parameter"; readonly name: string }
  | { readonly kind: "static"; readonly value: string };

export interface ParsedEveRoutePattern {
  /** Canonical registration path. Parameter names are preserved for runtime params. */
  readonly canonicalPath: string;
  /** Canonical collision identity. Parameter names are intentionally erased. */
  readonly identityPattern: string;
  readonly segments: readonly EveRoutePatternSegment[];
}

export class EveRoutePatternError extends Error {
  readonly path: string;
  readonly reason: string;

  constructor(path: string, reason: string) {
    super(`Invalid eve route pattern "${path}": ${reason}`);
    this.name = "EveRoutePatternError";
    this.path = path;
    this.reason = reason;
  }
}

const PLAIN_PARAMETER_NAME = /^\w+$/;
const ROUTER_METASYNTAX = /[:*?+(){}\\]/;
const INVALID_STATIC_CHARACTER = /[\p{Cc}\p{Z}#]/u;

/**
 * Parses eve's deliberately small route grammar.
 *
 * A route is an absolute path made from non-empty static segments and
 * whole-segment plain named parameters (`:name`). One trailing slash is
 * accepted and canonicalized away. rou3 regexes, wildcards, modifiers,
 * groups, escapes, embedded parameters, and empty segments are not part of
 * the eve authoring contract.
 */
export function parseEveRoutePattern(path: string): ParsedEveRoutePattern {
  if (typeof path !== "string" || path.length === 0 || !path.startsWith("/")) {
    throw new EveRoutePatternError(path, 'expected an absolute path beginning with "/".');
  }

  if (path === "/") {
    return { canonicalPath: path, identityPattern: path, segments: [] };
  }
  const canonicalPath = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

  const rawSegments = canonicalPath.slice(1).split("/");
  const segments = rawSegments.map((segment): EveRoutePatternSegment => {
    if (segment.length === 0) {
      throw new EveRoutePatternError(path, "empty path segments are not allowed.");
    }
    if (segment === "." || segment === "..") {
      throw new EveRoutePatternError(path, "dot path segments are not allowed.");
    }
    if (segment.startsWith(":")) {
      const name = segment.slice(1);
      if (!PLAIN_PARAMETER_NAME.test(name)) {
        throw new EveRoutePatternError(
          path,
          "parameters must occupy a whole segment and use a plain non-empty name.",
        );
      }
      return { kind: "parameter", name };
    }
    if (ROUTER_METASYNTAX.test(segment)) {
      throw new EveRoutePatternError(
        path,
        "static segments cannot contain route metasyntax (:, *, ?, +, (, ), {, }, or \\).",
      );
    }
    if (INVALID_STATIC_CHARACTER.test(segment)) {
      throw new EveRoutePatternError(
        path,
        "static segments cannot contain whitespace, control characters, or fragments.",
      );
    }
    return { kind: "static", value: segment };
  });

  return {
    canonicalPath: `/${segments.map(formatEveRoutePatternSegment).join("/")}`,
    identityPattern: `/${segments
      .map((segment) => (segment.kind === "parameter" ? ":_" : segment.value))
      .join("/")}`,
    segments,
  };
}

/** Returns whether two valid eve patterns can match at least one common path. */
export function eveRoutePatternsOverlap(left: string, right: string): boolean {
  const leftSegments = parseEveRoutePattern(left).segments;
  const rightSegments = parseEveRoutePattern(right).segments;
  if (leftSegments.length !== rightSegments.length) return false;

  return leftSegments.every((segment, index) => {
    const other = rightSegments[index]!;
    return (
      segment.kind === "parameter" || other.kind === "parameter" || segment.value === other.value
    );
  });
}

/** Matches a concrete request pathname against one valid eve route pattern. */
export function eveRoutePatternMatchesPath(pattern: string, pathname: string): boolean {
  const patternSegments = parseEveRoutePattern(pattern).segments;
  const canonicalPathname =
    pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (!canonicalPathname.startsWith("/")) return false;
  const pathSegments = canonicalPathname === "/" ? [] : canonicalPathname.slice(1).split("/");
  if (patternSegments.length !== pathSegments.length) return false;

  return patternSegments.every((segment, index) => {
    const concrete = pathSegments[index]!;
    return concrete.length > 0 && (segment.kind === "parameter" || segment.value === concrete);
  });
}

function formatEveRoutePatternSegment(segment: EveRoutePatternSegment): string {
  return segment.kind === "parameter" ? `:${segment.name}` : segment.value;
}
