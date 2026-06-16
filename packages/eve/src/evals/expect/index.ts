import { Levenshtein as AutoevalsLevenshtein } from "autoevals";

import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import { deepEquals } from "#evals/match.js";
import type { Assertion, AssertionSeverity } from "#evals/types.js";

export type { Assertion, AssertionHandle, AssertionSeverity } from "#evals/types.js";

interface AssertionSpec {
  readonly name: string;
  readonly severity: AssertionSeverity;
  readonly threshold?: number;
  score(value: unknown): number | Promise<number>;
}

function makeAssertion(spec: AssertionSpec): Assertion {
  return {
    name: spec.name,
    severity: spec.severity,
    threshold: spec.threshold,
    score: spec.score,
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

/**
 * Passes when the value (coerced to a string) contains `substring`. A hard
 * gate by default. Apply with `t.check(value, includes("..."))`.
 */
export function includes(substring: string): Assertion {
  return makeAssertion({
    name: `includes(${substring})`,
    severity: "gate",
    score: (value) => (String(value ?? "").includes(substring) ? 1 : 0),
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
    score: (value) => (deepEquals(value, expected) ? 1 : 0),
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
    score: async (value) => {
      const outcome = await schema["~standard"].validate(value);
      return !("issues" in outcome) || outcome.issues === undefined ? 1 : 0;
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
    score: async (value) => {
      const result = await AutoevalsLevenshtein({ output: String(value ?? ""), expected });
      return result.score ?? 0;
    },
  });
}
