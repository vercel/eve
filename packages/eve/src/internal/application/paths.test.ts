import { createHash } from "node:crypto";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePackageRoot } from "#internal/application/package.js";
import { resolveWorkflowBuildDirectory } from "#internal/application/paths.js";

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
