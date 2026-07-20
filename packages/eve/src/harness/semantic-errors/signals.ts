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
  /** Node/undici style error code (`ECONNREFUSED`, `EADDRINUSE`, …). */
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
    if (typeof candidate.code === "string" && candidate.code.length > 0) {
      link.code = candidate.code;
    }
    if (typeof candidate.statusCode === "number") {
      link.statusCode = candidate.statusCode;
    }
    if (typeof candidate.type === "string" && candidate.type.length > 0) {
      link.type = candidate.type;
    }
    if (typeof candidate.hint === "string" && candidate.hint.length > 0) {
      link.hint = candidate.hint;
    }
    chain.push(link);
  }
  return { chain };
}
