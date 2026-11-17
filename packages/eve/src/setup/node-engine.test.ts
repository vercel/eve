import { describe, expect, it } from "vitest";

import {
  pinnedNodeEngineMajor,
  reconcileNodeEngine,
  type NodeEngineReconciliation,
} from "./node-engine.js";

describe("reconcileNodeEngine", () => {
  it.each<[unknown, NodeEngineReconciliation]>([
    ["26.x", { kind: "unchanged" }],
    ["^26.5.0", { kind: "unchanged" }],
    [">=26 <27", { kind: "unchanged" }],
    [">=24", { kind: "overridden", previous: ">=24", next: "26.x" }],
    ["24.x", { kind: "overridden", previous: "24.x", next: "26.x" }],
    ["22.x", { kind: "overridden", previous: "22.x", next: "26.x" }],
    ["not-semver", { kind: "overridden", previous: "not-semver", next: "26.x" }],
    [null, { kind: "overridden", previous: null, next: "26.x" }],
    [undefined, { kind: "added", next: "26.x" }],
  ])("reconciles %s → %o", (existing, expected) => {
    expect(reconcileNodeEngine(existing, ">=24")).toEqual(expected);
  });
});

describe("pinnedNodeEngineMajor", () => {
  it.each<[string, string]>([
    [">=24", "26.x"],
    [">=24.5.0 <27", "26.x"],
    ["26.x", "26.x"],
    ["25.x", "25.x"],
    ["24.5.x || 25.x", "25.x"],
    [">=26.5.0", "27.x"],
    ["24.5.0 || >=27.2.0", "28.x"],
  ])("pins %s → %s", (range, expected) => {
    expect(pinnedNodeEngineMajor(range)).toBe(expected);
  });

  it.each<[string, RegExp]>([
    ["^24.5.0", /cannot be represented by a major pin/],
    ["24.5.x", /cannot be represented by a major pin/],
    ["not-semver", /invalid Node\.js engine range/],
  ])("rejects %s", (range, expected) => {
    expect(() => pinnedNodeEngineMajor(range)).toThrow(expected);
  });
});
