import type { ErrorLink, ErrorSignals } from "./signals.js";

export type SemanticErrorTag =
  | "gateway"
  | "model-provider"
  | "workflow"
  | "sandbox"
  | "system"
  | "config"
  | "transient"
  | "recoverable"
  | "refused";

export type LinkPredicate = (link: ErrorLink) => boolean;

export interface SemanticErrorRule {
  readonly id: string;
  readonly name: string;
  readonly tags: readonly SemanticErrorTag[];
  readonly when: LinkPredicate;
  readonly message: string | ((link: ErrorLink) => string);
  readonly hint?: string | ((link: ErrorLink) => string | undefined);
}

export interface SemanticErrorSummary {
  readonly id: string;
  readonly name: string;
  readonly tags: readonly SemanticErrorTag[];
  readonly message: string;
  readonly hint?: string;
}

export function evaluateSemanticErrorRules(
  rules: readonly SemanticErrorRule[],
  signals: ErrorSignals,
): SemanticErrorSummary | null {
  for (const rule of rules) {
    const link = signals.chain.find((candidate) => rule.when(candidate));
    if (link === undefined) continue;
    const summary: {
      -readonly [Key in keyof SemanticErrorSummary]: SemanticErrorSummary[Key];
    } = {
      id: rule.id,
      name: rule.name,
      tags: rule.tags,
      message: typeof rule.message === "string" ? rule.message : rule.message(link),
    };
    const hint = typeof rule.hint === "function" ? rule.hint(link) : rule.hint;
    if (hint !== undefined && hint.length > 0) summary.hint = hint;
    return summary;
  }
  return null;
}

export function nameIs(...names: readonly string[]): LinkPredicate {
  return (link) => link.name !== undefined && names.includes(link.name);
}

export function codeIs(...codes: readonly string[]): LinkPredicate {
  return (link) => link.code !== undefined && codes.includes(link.code);
}

export function statusCodeIs(...statusCodes: readonly number[]): LinkPredicate {
  return (link) => link.statusCode !== undefined && statusCodes.includes(link.statusCode);
}

export function typeIs(...types: readonly string[]): LinkPredicate {
  return (link) => link.type !== undefined && types.includes(link.type);
}

export function messageIs(...messages: readonly string[]): LinkPredicate {
  return (link) => messages.includes(link.message.trim());
}

export function messageMatches(pattern: RegExp): LinkPredicate {
  return (link) => pattern.test(link.message);
}

export function allOf(...predicates: readonly LinkPredicate[]): LinkPredicate {
  return (link) => predicates.every((predicate) => predicate(link));
}

export function anyOf(...predicates: readonly LinkPredicate[]): LinkPredicate {
  return (link) => predicates.some((predicate) => predicate(link));
}
