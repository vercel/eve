import { describe, expect, it } from "vitest";

import {
  classifyBuiltInWorkflowWorldTarget,
  isWorkflowWorldPackageName,
  resolveBuiltInWorkflowWorldPackage,
} from "#internal/workflow/world-target.js";

describe("Workflow world target inventory", () => {
  it("maps the closed native inventory to vendored packages", () => {
    expect(resolveBuiltInWorkflowWorldPackage("local")).toBe("@workflow/world-local");
    expect(resolveBuiltInWorkflowWorldPackage("vercel")).toBe("@workflow/world-vercel");
  });

  it("classifies aliases for the same native targets", () => {
    expect(classifyBuiltInWorkflowWorldTarget("local")).toBe("local");
    expect(classifyBuiltInWorkflowWorldTarget("@workflow/world-local")).toBe("local");
    expect(classifyBuiltInWorkflowWorldTarget("vercel")).toBe("vercel");
    expect(classifyBuiltInWorkflowWorldTarget("@workflow/world-vercel")).toBe("vercel");
    expect(classifyBuiltInWorkflowWorldTarget("@acme/world-redis")).toBeUndefined();
  });

  it("accepts package names and rejects path-like targets", () => {
    expect(isWorkflowWorldPackageName("@acme/world-redis")).toBe(true);
    expect(isWorkflowWorldPackageName("world-redis")).toBe(true);
    expect(isWorkflowWorldPackageName("./relative/world.js")).toBe(false);
    expect(isWorkflowWorldPackageName("/absolute/world.js")).toBe(false);
    expect(isWorkflowWorldPackageName("file:///world.js")).toBe(false);
    expect(isWorkflowWorldPackageName("@acme/world/subpath")).toBe(false);
  });
});
