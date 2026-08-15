import { describe, expect, it } from "vitest";

import { resolveWorkflowWorldImport } from "#internal/workflow/world-target.js";

describe("resolveWorkflowWorldImport", () => {
  it("maps the built-in world shorthands to their packages", () => {
    expect(resolveWorkflowWorldImport("local")).toBe("@workflow/world-local");
    expect(resolveWorkflowWorldImport("vercel")).toBe("@workflow/world-vercel");
  });

  it("passes custom world specifiers through unchanged", () => {
    expect(resolveWorkflowWorldImport("@acme/world-redis")).toBe("@acme/world-redis");
    expect(resolveWorkflowWorldImport("./relative/world.js")).toBe("./relative/world.js");
  });
});
