import { describe, expect, it } from "vitest";

import { createProgressSnapshot } from "#execution/session-progress.js";
import { renderSessionProgressStep } from "#execution/session-progress-renderer-step.js";

describe("renderSessionProgressStep", () => {
  it("returns driver-owned state independently of turn context", async () => {
    const snapshot = createProgressSnapshot();
    await expect(renderSessionProgressStep({ previousRenderCount: 2, snapshot })).resolves.toEqual({
      renderCount: 3,
      snapshot,
    });
  });
});
