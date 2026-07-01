import { describe, expect, it } from "vitest";

import { DEFAULT_EVAL_MODEL } from "#evals/default-eval-model.js";

describe("DEFAULT_EVAL_MODEL", () => {
  it("is a gateway provider/model id", () => {
    expect(DEFAULT_EVAL_MODEL).toBe("anthropic/claude-sonnet-5");
    expect(DEFAULT_EVAL_MODEL).toMatch(/^[^/]+\/[^/]+$/);
  });
});
