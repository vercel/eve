import { describe, expect, it } from "vitest";

import { applyWorkflowSpecVersionDefault } from "#internal/workflow/spec-version-default.js";

describe("applyWorkflowSpecVersionDefault", () => {
  it.each([
    { name: "defaults an unset version to 9", env: {}, expected: "9" },
    { name: "treats an empty version as unset", env: { WORKFLOW_SPEC_VERSION: "" }, expected: "9" },
    { name: "keeps an operator version", env: { WORKFLOW_SPEC_VERSION: "8" }, expected: "8" },
    {
      name: "keeps the legacy sealed-log choice",
      env: { WORKFLOW_SEALED_LOG: "0" },
      expected: undefined,
    },
  ])("$name", ({ env, expected }) => {
    const target: Record<string, string | undefined> = { ...env };
    applyWorkflowSpecVersionDefault(target);
    expect(target.WORKFLOW_SPEC_VERSION).toBe(expected);
  });
});
