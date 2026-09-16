import { describe, expect, it } from "vitest";

import type { ModelSettingsRequest } from "#setup/flows/model.js";

import { initialModelPickerState, transitionModelPicker } from "./model-picker.js";

const request: ModelSettingsRequest = {
  model: {
    kind: "pick",
    current: "anthropic/claude-sonnet",
    options: [
      { value: "anthropic/claude-sonnet", label: "Claude Sonnet" },
      { value: "openai/gpt", label: "GPT" },
    ],
  },
  reasoning: null,
  serviceTier: { kind: "standard" },
  settingsEditable: false,
  externalRouting: false,
  capabilitiesFor: () => undefined,
};

describe("transitionModelPicker", () => {
  it("deletes the previous word from the model search", () => {
    const initial = initialModelPickerState(request);
    const transition = transitionModelPicker(
      { ...initial, select: { ...initial.select, filter: "claude sonnet" } },
      { type: "delete-word-backward" },
      request,
    );

    expect(transition).toMatchObject({
      kind: "render",
      state: { select: { filter: "claude " } },
    });
  });
});
