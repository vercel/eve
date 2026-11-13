import { describe, expect, it } from "vitest";

import {
  pinnedNodeEngineMajor,
  reconcileNodeEngine,
  type NodeEngineReconciliation,
} from "./node-engine.js";

describe("reconcileNodeEngine", () => {
  // Each row is the authored `engines.node` value reconciled against eve's
  // ">=24" requirement (pinned major "26.x") and the result it must produce.
  it.each<[unknown, NodeEngineReconciliation]>([
    // Confined to the scaffolded major → kept as authored.
    ["26.x", { kind: "unchanged" }],
    ["^26.5.0", { kind: "unchanged" }],
    [">=26 <27", { kind: "unchanged" }],
    // Not confined to "26.x" → replaced with the pinned major.
    [">=24", { kind: "overridden", previous: ">=24", next: "26.x" }],
    ["24.x", { kind: "overridden", previous: "24.x", next: "26.x" }],
    ["22.x", { kind: "overridden", previous: "22.x", next: "26.x" }],
    ["not-semver", { kind: "overridden", previous: "not-semver", next: "26.x" }],
    [null, { kind: "overridden", previous: null, next: "26.x" }],
    // Absent → added.
    [undefined, { kind: "added", next: "26.x" }],
  ])("reconciles %s → %o", (existing, expected) => {
    expect(reconcileNodeEngine(existing, ">=24")).toEqual(expected);
  });
});

describe("pinnedNodeEngineMajor", () => {
  it.each<[string, string]>([
    // eve's scaffold major wins whenever the range fully covers it.
    [">=24", "26.x"],
    [">=24.5.0 <27", "26.x"],
    ["26.x", "26.x"],
    // Otherwise the lowest major the range fully covers.
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
