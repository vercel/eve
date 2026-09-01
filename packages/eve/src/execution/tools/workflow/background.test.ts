import { describe, expect, it } from "vitest";

import { parseWorkflowToolInput } from "./background.js";

describe("parseWorkflowToolInput", () => {
  it("passes a JSON object through", () => {
    expect(parseWorkflowToolInput({ service: "api" }, "deploy")).toEqual({ service: "api" });
  });

  it("rejects an input that cannot cross the run boundary, naming the tool", () => {
    for (const input of [new Date(0), "api", 42, null, undefined, ["api"]]) {
      expect(() => parseWorkflowToolInput(input, "deploy")).toThrow(
        /Tool "deploy" is a workflow, so its parsed input must be a JSON object/u,
      );
    }
  });
});
