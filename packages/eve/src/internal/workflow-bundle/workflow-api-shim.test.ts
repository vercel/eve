import { describe, expect, it } from "vitest";

import * as runtime from "#internal/workflow/runtime.js";
import * as shim from "#internal/workflow-bundle/workflow-api-shim.js";

describe("workflow/api driver shim", () => {
  it("binds every value the runtime exports so authored imports resolve", () => {
    expect(Object.keys(shim).sort()).toEqual(Object.keys(runtime).sort());
  });

  it("fails with the rule when a body calls it", () => {
    expect(() => shim.start()).toThrow('"use step"');
    expect(() => new shim.Run()).toThrow("not available inside a workflow body");
  });
});
