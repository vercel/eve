import { describe, expect, it } from "vitest";

import { filterEvalsByTags } from "#evals/cli/filter.js";
import type { EveEval } from "#evals/types.js";

function createEval(id: string, tags?: readonly string[]): EveEval {
  return { _tag: "EveEval", id, tags, test: async () => {} };
}

const untagged = createEval("untagged");
const fast = createEval("fast", ["fast"]);
const realModel = createEval("real-model-only", ["real-model"]);
const fastRealModel = createEval("fast-real-model", ["fast", "real-model"]);
const evaluations = [untagged, fast, realModel, fastRealModel];

describe("filterEvalsByTags", () => {
  it("returns every eval when no filters are given", () => {
    const result = filterEvalsByTags({ evaluations, includeTags: [], excludeTags: [] });
    expect(result).toEqual(evaluations);
  });

  it("keeps only evals carrying an include tag", () => {
    const result = filterEvalsByTags({ evaluations, includeTags: ["fast"], excludeTags: [] });
    expect(result.map((entry) => entry.id)).toEqual(["fast", "fast-real-model"]);
  });

  it("drops evals carrying an exclude tag", () => {
    const result = filterEvalsByTags({
      evaluations,
      excludeTags: ["real-model"],
      includeTags: [],
    });
    expect(result.map((entry) => entry.id)).toEqual(["untagged", "fast"]);
  });

  it("applies exclusion after inclusion", () => {
    const result = filterEvalsByTags({
      evaluations,
      excludeTags: ["real-model"],
      includeTags: ["fast"],
    });
    expect(result.map((entry) => entry.id)).toEqual(["fast"]);
  });

  it("returns an empty list when exclusion removes every match", () => {
    const result = filterEvalsByTags({
      evaluations: [realModel],
      excludeTags: ["real-model"],
      includeTags: [],
    });
    expect(result).toEqual([]);
  });

  it("treats untagged evals as excluded by include filters only", () => {
    const result = filterEvalsByTags({
      evaluations: [untagged],
      excludeTags: ["real-model"],
      includeTags: [],
    });
    expect(result).toEqual([untagged]);
  });
});
