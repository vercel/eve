import { describe, expect, it } from "vitest";

import { fileMayContainMatchingEval } from "#evals/runner/discover.js";

describe("fileMayContainMatchingEval", () => {
  it("treats every file as a candidate when no filters are given", () => {
    expect(fileMayContainMatchingEval("held-out/secret", [])).toBe(true);
  });

  it("selects a file whose id exactly equals a filter", () => {
    expect(fileMayContainMatchingEval("tuning/alpha", ["tuning/alpha"])).toBe(true);
  });

  it("selects a file nested under a partition filter", () => {
    expect(fileMayContainMatchingEval("tuning/alpha", ["tuning"])).toBe(true);
    expect(fileMayContainMatchingEval("tuning/nested/deep", ["tuning"])).toBe(true);
  });

  it("selects a file when a filter targets an array index it may export", () => {
    expect(fileMayContainMatchingEval("tuning/dataset", ["tuning/dataset/0001"])).toBe(true);
  });

  it("rejects a file in a sibling partition", () => {
    expect(fileMayContainMatchingEval("held-out/secret", ["tuning"])).toBe(false);
    expect(fileMayContainMatchingEval("tuning/alpha", ["held-out"])).toBe(false);
  });

  it("rejects on partial segment overlap", () => {
    expect(fileMayContainMatchingEval("tuning-extra/case", ["tuning"])).toBe(false);
    expect(fileMayContainMatchingEval("tuning/alpha", ["tuning/alph"])).toBe(false);
  });

  it("selects when any one of several filters could match", () => {
    expect(fileMayContainMatchingEval("held-out/secret", ["tuning", "held-out"])).toBe(true);
  });
});
