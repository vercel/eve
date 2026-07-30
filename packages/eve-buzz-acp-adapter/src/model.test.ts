import { describe, expect, it } from "vitest";
import { EVE_MODEL_CONFIG_ID, fixedModelResult, isFixedModelRequest } from "./model.js";

describe("fixed authored model", () => {
  it("projects one stable and unstable model choice", () => {
    expect(fixedModelResult("anthropic/claude-sonnet-5")).toMatchObject({
      configOptions: [
        {
          id: EVE_MODEL_CONFIG_ID,
          category: "model",
          currentValue: "anthropic/claude-sonnet-5",
          options: [{ value: "anthropic/claude-sonnet-5" }],
        },
      ],
      models: {
        currentModelId: "anthropic/claude-sonnet-5",
        availableModels: [{ modelId: "anthropic/claude-sonnet-5" }],
      },
    });
  });

  it("accepts only no-op selections of the authored model", () => {
    expect(
      isFixedModelRequest(
        "session/set_config_option",
        { configId: EVE_MODEL_CONFIG_ID, value: "model-a" },
        "model-a",
      ),
    ).toBe(true);
    expect(isFixedModelRequest("session/set_model", { modelId: "model-b" }, "model-a")).toBe(false);
  });
});
