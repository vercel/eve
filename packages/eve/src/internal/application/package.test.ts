import { describe, expect, it } from "vitest";

import { resolveWorkflowModulePath } from "#internal/application/package.js";

describe("resolveWorkflowModulePath", () => {
  it("resolves historical workflow specifiers to narrowed runtime modules", () => {
    expect(resolveWorkflowModulePath("workflow")).toMatch(/\/src\/internal\/workflow\/index\.ts$/);
    expect(resolveWorkflowModulePath("workflow/api")).toMatch(
      /\/\.generated\/compiled\/@workflow\/core\/runtime\.js$/,
    );
    expect(resolveWorkflowModulePath("workflow/internal/builtins")).toMatch(
      /\/src\/internal\/workflow\/builtins\.ts$/,
    );
    expect(resolveWorkflowModulePath("workflow/internal/private")).toMatch(
      /\/\.generated\/compiled\/@workflow\/core\/private\.js$/,
    );
  });
});
