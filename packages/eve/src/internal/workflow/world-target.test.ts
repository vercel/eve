import { describe, expect, it } from "vitest";

import {
  resolveWorkflowWorldImport,
  usesHubWorkflowWorld,
} from "#internal/workflow/world-target.js";

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

it("recognizes hub without changing default or arbitrary worlds", () => {
  expect(resolveWorkflowWorldImport("hub")).toBe("eve/world-hub");
  expect(resolveWorkflowWorldImport("local")).toBe("@workflow/world-local");
  expect(resolveWorkflowWorldImport("custom-world")).toBe("custom-world");
  for (const world of [undefined, "local", "vercel", "custom-world"])
    expect(usesHubWorkflowWorld(world)).toBe(false);
  for (const world of ["hub", "eve/world-hub"]) expect(usesHubWorkflowWorld(world)).toBe(true);
});
