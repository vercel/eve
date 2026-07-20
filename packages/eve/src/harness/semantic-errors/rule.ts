import type { ErrorLink, ErrorSignals } from "./signals.js";

/**
 * Classification tags a rule carries in addition to its domain:
 *
 * - `config` — the failure points at a fixable setup mistake (missing or
 *   invalid credentials, unknown model id). The model-call classifier
 *   treats a matched `config` rule as terminal.
 * - `transient` — the failure is expected to clear on retry.
 */
export type SemanticErrorTag =
  | "gateway"
  | "model-provider"
  | "workflow"
  | "sandbox"
  | "system"
  | "config"
  | "transient";

/** A predicate over one extracted cause-chain link. */
export type LinkPredicate = (link: ErrorLink) => boolean;

/**
 * One catalog rule, in the linter shape: a stable id, a headline, a
 * declarative predicate over extracted {@link ErrorLink} facts, and the
 * remediation copy. Rules are pure and independent; the catalog is an
 * ordered list where the first match wins, so put specific rules before
 * general ones.
 */
export interface SemanticErrorRule {
  /** Stable kebab-case catalog identifier, greppable across logs and code. */
  readonly id: string;
  /** Short human-readable failure title used as the display headline. */
  readonly name: string;
  readonly tags: readonly SemanticErrorTag[];
  /** Matches when ANY link on the cause chain satisfies the predicate. */
  readonly when: LinkPredicate;
  /**
   * Remediation text written for end users, or a projection of the
   * matched link (e.g. pass-through for eve-authored error messages
   * that are already actionable).
   */
  readonly message: string | ((link: ErrorLink) => string);
}

/** A matched rule projected into a displayable summary. */
export interface SemanticErrorSummary {
  readonly id: string;
  readonly name: string;
  readonly message: string;
}

/** Evaluates an ordered rule list against extracted signals; first match wins. */
export function evaluateSemanticErrorRules(
  rules: readonly SemanticErrorRule[],
  signals: ErrorSignals,
): SemanticErrorSummary | null {
  for (const rule of rules) {
    const link = signals.chain.find((candidate) => rule.when(candidate));
    if (link === undefined) continue;
    return {
      id: rule.id,
      name: rule.name,
      message: typeof rule.message === "string" ? rule.message : rule.message(link),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Predicate combinators — the declarative vocabulary rules are written in.
// ---------------------------------------------------------------------------

/** Matches when the link's `name` equals any of the given class names. */
export function nameIs(...names: readonly string[]): LinkPredicate {
  return (link) => link.name !== undefined && names.includes(link.name);
}

/** Matches when the link's `code` equals any of the given codes. */
export function codeIs(...codes: readonly string[]): LinkPredicate {
  return (link) => link.code !== undefined && codes.includes(link.code);
}

/** Matches when the link's gateway body `type` equals any of the given types. */
export function typeIs(...types: readonly string[]): LinkPredicate {
  return (link) => link.type !== undefined && types.includes(link.type);
}

/**
 * Matches when the link's message equals one of the given strings exactly
 * (after trimming). Exact equality, not containment: a user error that
 * merely *mentions* a known failure string must not be reclassified.
 */
export function messageIs(...messages: readonly string[]): LinkPredicate {
  return (link) => messages.includes(link.message.trim());
}

/** Matches when the link's message matches the pattern. */
export function messageMatches(pattern: RegExp): LinkPredicate {
  return (link) => pattern.test(link.message);
}

/** Matches when every given predicate matches the same link. */
export function allOf(...predicates: readonly LinkPredicate[]): LinkPredicate {
  return (link) => predicates.every((predicate) => predicate(link));
}

/** Matches when any given predicate matches the link. */
export function anyOf(...predicates: readonly LinkPredicate[]): LinkPredicate {
  return (link) => predicates.some((predicate) => predicate(link));
}
