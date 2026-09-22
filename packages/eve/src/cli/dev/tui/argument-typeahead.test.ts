import { describe, expect, it } from "vitest";

import {
  argumentTypeaheadCompletion,
  argumentTypeaheadFor,
  argumentTypeaheadQuery,
  moveArgumentTypeaheadSelection,
  selectedArgumentSuggestion,
} from "./argument-typeahead.js";

const models = [
  { value: "anthropic/claude-sonnet", label: "Claude Sonnet", hint: "Anthropic" },
  { value: "openai/gpt-5", label: "GPT-5", hint: "OpenAI" },
];

describe("argumentTypeaheadQuery", () => {
  it("recognizes one in-progress /model or /add argument", () => {
    expect(argumentTypeaheadQuery("/model ant")).toEqual({ command: "model", query: "ant" });
    expect(argumentTypeaheadQuery("/add channel/slack")).toEqual({
      command: "add",
      query: "channel/slack",
    });
    expect(argumentTypeaheadQuery("/model one two")).toBeUndefined();
    expect(argumentTypeaheadQuery("hello")).toBeUndefined();
  });
});

describe("argumentTypeaheadFor", () => {
  it("filters labels, values, and hints, then completes the selected value", () => {
    let state = argumentTypeaheadFor("model", "anth", models);
    expect(state.suggestions).toEqual([models[0]]);
    expect(argumentTypeaheadCompletion(state, selectedArgumentSuggestion(state)!)).toBe(
      "/model anthropic/claude-sonnet",
    );

    state = argumentTypeaheadFor("model", "", models);
    state = moveArgumentTypeaheadSelection(state, 1);
    expect(selectedArgumentSuggestion(state)).toEqual(models[1]);
  });
});
