import { createHash } from "node:crypto";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePackageRoot } from "#internal/application/package.js";
import {
  resolveOutputDirectory,
  resolveWorkflowBuildDirectory,
} from "#internal/application/paths.js";

describe("resolveWorkflowBuildDirectory", () => {
  it("keys the workflow build cache by app root only (stable across eve versions)", () => {
    const appRoot = "/tmp/eve-app";
    const expectedCacheKey = createHash("sha256").update(appRoot).digest("hex").slice(0, 12);

    expect(resolveWorkflowBuildDirectory(appRoot)).toBe(
      join(resolvePackageRoot(), ".eve", "workflow-cache", expectedCacheKey),
    );
  });

  it("produces distinct directories for distinct app roots", () => {
    const dirA = resolveWorkflowBuildDirectory("/tmp/app-a");
    const dirB = resolveWorkflowBuildDirectory("/tmp/app-b");

    expect(dirA).not.toBe(dirB);
  });
});

describe("resolveOutputDirectory", () => {
  it("resolves the platform's output directory against the app root unless it is absolute", () => {
    const appRoot = join("/", "app");
    expect(resolveOutputDirectory(appRoot, {})).toBe(join(appRoot, ".output"));
    expect(resolveOutputDirectory(appRoot, { outputDirectory: "dist/worker" })).toBe(
      join(appRoot, "dist", "worker"),
    );
    const absolute = join("/", "srv", "worker");
    expect(resolveOutputDirectory(appRoot, { outputDirectory: absolute })).toBe(absolute);
  });
});
