import { Levenshtein as AutoevalsLevenshtein } from "autoevals";

import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import { formatDiagnosticValue, toDiagnosticMetadataValue } from "#evals/diagnostics.js";
import { deepEquals } from "#evals/match.js";
import { testRegExp } from "#evals/match.js";
import type { Assertion, AssertionEvaluation, AssertionSeverity } from "#evals/types.js";

export type {
  Assertion,
  AssertionEvaluation,
  AssertionHandle,
  AssertionSeverity,
} from "#evals/types.js";

interface AssertionSpec {
  readonly name: string;
  readonly severity: AssertionSeverity;
  readonly threshold?: number;
  evaluate(value: unknown): AssertionEvaluation | number | Promise<AssertionEvaluation | number>;
}

function makeAssertion(spec: AssertionSpec): Assertion {
  const evaluate = (value: unknown): AssertionEvaluation | Promise<AssertionEvaluation> => {
    const result = spec.evaluate(value);
    return result instanceof Promise
      ? result.then(normalizeEvaluation)
      : normalizeEvaluation(result);
  };
  return {
    name: spec.name,
    severity: spec.severity,
    threshold: spec.threshold,
    evaluate,
    score(value) {
      const result = evaluate(value);
      return result instanceof Promise ? result.then((outcome) => outcome.score) : result.score;
    },
    gate(threshold) {
      return makeAssertion({ ...spec, severity: "gate", threshold });
    },
    soft(threshold) {
      return makeAssertion({ ...spec, severity: "soft", threshold });
    },
    atLeast(threshold) {
      return makeAssertion({ ...spec, severity: "soft", threshold });
    },
  };
}

function normalizeEvaluation(result: AssertionEvaluation | number): AssertionEvaluation {
  return typeof result === "number" ? { score: result } : result;
}

/**
 * Passes when the value (coerced to a string) contains a substring or matches
 * a RegExp. A hard gate by default.
 */
export function includes(substring: string | RegExp): Assertion {
  return makeAssertion({
    name: `includes(${substring})`,
    severity: "gate",
    evaluate: (value) => {
      const text = String(value ?? "");
      const passed =
        typeof substring === "string" ? text.includes(substring) : testRegExp(substring, text);
      if (passed) return 1;
      return {
        score: 0,
        message: `expected ${formatDiagnosticValue(text)} to include ${formatDiagnosticValue(String(substring))}`,
        metadata: { actual: text, expected: String(substring) },
      };
    },
  });
}

/** Passes when `predicate` returns true for the supplied value. */
export function satisfies<T = unknown>(predicate: (value: T) => boolean, label: string): Assertion {
  if (label.trim().length === 0) throw new Error("satisfies() requires a non-empty label.");
  return makeAssertion({
    name: `satisfies(${label})`,
    severity: "gate",
    evaluate: (value) =>
      predicate(value as T)
        ? 1
        : {
            score: 0,
            message: `predicate did not hold for ${formatDiagnosticValue(value)}`,
            metadata: { actual: toDiagnosticMetadataValue(value), predicate: label },
          },
  });
}

/**
 * Passes when the value deep-equals `expected` (exact structural equality).
 * A hard gate by default.
 */
export function equals(expected: unknown): Assertion {
  return makeAssertion({
    name: "equals",
    severity: "gate",
    evaluate: (value) =>
      deepEquals(value, expected)
        ? 1
        : {
            score: 0,
            message: `expected ${formatDiagnosticValue(expected)}; received ${formatDiagnosticValue(value)}`,
            metadata: {
              actual: toDiagnosticMetadataValue(value),
              expected: toDiagnosticMetadataValue(expected),
            },
          },
  });
}

/**
 * Passes when the value validates against a Standard Schema (e.g. a Zod
 * schema). A hard gate by default.
 */
export function matches(schema: StandardSchemaV1): Assertion {
  return makeAssertion({
    name: "matches",
    severity: "gate",
    evaluate: async (value) => {
      const outcome = await schema["~standard"].validate(value);
      if (!("issues" in outcome) || outcome.issues === undefined) return 1;
      return {
        score: 0,
        message: `schema validation failed: ${outcome.issues.map(formatSchemaIssue).join("; ")}`,
        metadata: {
          actual: toDiagnosticMetadataValue(value),
          issues: toDiagnosticMetadataValue(outcome.issues),
        },
      };
    },
  });
}

/**
 * Scores normalized character-level Levenshtein similarity between the value
 * and `expected` (1 = identical, 0 = entirely different). Soft by default —
 * tracked unless you set a bar with `.atLeast(...)`. Use it for fuzzy
 * comparison when exact match is too strict but a judge model is overkill.
 */
export function similarity(expected: string): Assertion {
  return makeAssertion({
    name: "similarity",
    severity: "soft",
    evaluate: async (value) => {
      const actual = String(value ?? "");
      const result = await AutoevalsLevenshtein({ output: actual, expected });
      return {
        score: result.score ?? 0,
        message: `expected similarity to ${formatDiagnosticValue(expected)}; received ${formatDiagnosticValue(actual)}`,
        metadata: { actual, expected },
      };
    },
  });
}

function formatSchemaIssue(issue: StandardSchemaV1.Issue): string {
  const path =
    issue.path === undefined
      ? ""
      : `${issue.path
          .map((segment) => (typeof segment === "object" ? String(segment.key) : String(segment)))
          .join(".")}: `;
  return `${path}${issue.message}`;
}
