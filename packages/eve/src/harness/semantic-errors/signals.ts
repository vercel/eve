import { walkCauseChain } from "#shared/errors.js";
import { isObject } from "#shared/guards.js";

/**
 * The structural facts extracted from one throwable on a cause chain.
 * Rules match on these fields only — never on live objects — so the
 * same rule works for real Errors and for plain-object shapes that
 * crossed a workflow step boundary (structured clone strips prototypes
 * but keeps own fields).
 */
export interface ErrorLink {
  readonly name?: string;
  readonly message: string;
  /**
   * Node/undici style error code (`ECONNREFUSED`, `EADDRINUSE`, …), or a provider error code
   * (`cyber_policy`) from the error or its response body.
   */
  readonly code?: string;
  readonly statusCode?: number;
  /** Gateway error body discriminator (`rate_limit_exceeded`, …). */
  readonly type?: string;
  /**
   * Structured remediation authored at the throw site (eve's own error
   * classes carry it as an own property, so it survives structured
   * clone). Pass-through rules surface it as the summary hint.
   */
  readonly hint?: string;
}

/** The full cause chain of a throwable, outermost first. */
export interface ErrorSignals {
  readonly chain: readonly ErrorLink[];
}

/** Projects a throwable into the flat signals the rule engine matches on. */
export function extractErrorSignals(error: unknown): ErrorSignals {
  const chain: ErrorLink[] = [];
  for (const candidate of walkCauseChain(error)) {
    if (!isObject(candidate)) continue;
    const link: { -readonly [Key in keyof ErrorLink]: ErrorLink[Key] } = {
      message: typeof candidate.message === "string" ? candidate.message : "",
    };
    if (typeof candidate.name === "string" && candidate.name.length > 0) {
      link.name = candidate.name;
    }
    const bodies = readProviderErrorBodies(candidate);
    const code = readErrorField(candidate, bodies, "code");
    if (code !== undefined) link.code = code;
    if (typeof candidate.statusCode === "number") {
      link.statusCode = candidate.statusCode;
    }
    const type = readErrorField(candidate, bodies, "type");
    if (type !== undefined) link.type = type;
    if (typeof candidate.hint === "string" && candidate.hint.length > 0) {
      link.hint = candidate.hint;
    }
    chain.push(link);
  }
  return { chain };
}

/**
 * The provider error bodies the AI SDK keeps on an error, in lookup order: `data`, then the
 * parsed `responseBody`. An `APICallError` carries the provider's `code` and `type` only there.
 */
function readProviderErrorBodies(candidate: Record<string, unknown>): readonly unknown[] {
  if (typeof candidate.responseBody !== "string") return [candidate.data];
  try {
    return [candidate.data, JSON.parse(candidate.responseBody)];
  } catch {
    return [candidate.data];
  }
}

/** Reads `field` from the error itself, else from its provider error bodies. */
function readErrorField(
  candidate: Record<string, unknown>,
  bodies: readonly unknown[],
  field: "code" | "type",
): string | undefined {
  const own = candidate[field];
  if (typeof own === "string" && own.length > 0) return own;

  for (const body of bodies) {
    const value = readBodyField(body, field);
    if (value !== undefined) return value;
  }
  return undefined;
}

function readBodyField(value: unknown, field: "code" | "type"): string | undefined {
  if (!isObject(value)) return undefined;
  const nestedError = value.error;
  if (isObject(nestedError) && typeof nestedError[field] === "string") {
    const nested = nestedError[field];
    return nested.length > 0 ? nested : undefined;
  }
  const top = value[field];
  return typeof top === "string" && top.length > 0 ? top : undefined;
}
