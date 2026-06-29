import { describe, expect, it } from "vitest";

import {
  resolveExpectedWorkflowVersion,
  resolveWorkflowModulePath,
} from "#internal/application/package.js";

describe("resolveWorkflowModulePath", () => {
  it("resolves historical workflow specifiers to narrowed runtime modules", () => {
    expect(resolveWorkflowModulePath("workflow")).toMatch(/\/src\/internal\/workflow\/index\.ts$/);
    expect(resolveWorkflowModulePath("workflow/api")).toMatch(
      /\/src\/internal\/workflow\/runtime\.ts$/,
    );
    expect(resolveWorkflowModulePath("workflow/internal/builtins")).toMatch(
      /\/src\/internal\/workflow\/builtins\.ts$/,
    );
    expect(resolveWorkflowModulePath("workflow/internal/private")).toMatch(
      /\/\.generated\/compiled\/@workflow\/core\/private\.js$/,
    );
    expect(resolveWorkflowModulePath("workflow/runtime")).toMatch(
      /\/src\/internal\/workflow\/runtime\.ts$/,
    );
  });
});

describe("resolveExpectedWorkflowVersion", () => {
  it("reads the @workflow/core line from eve's own package.json", () => {
    // Single source of truth: eve declares the workflow line it bundles in its
    // own package.json, so this resolves to a concrete prerelease version.
    expect(resolveExpectedWorkflowVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
