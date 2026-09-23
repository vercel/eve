import { describe, expect, it } from "vitest";

import {
  argumentTypeaheadCompletion,
  argumentTypeaheadFor,
  argumentTypeaheadQuery,
  moveArgumentTypeaheadSelection,
  renderArgumentSuggestions,
  selectedArgumentSuggestion,
} from "./argument-typeahead.js";
import { stripAnsi } from "#cli/ui/terminal-text.js";
import { createTheme } from "./theme.js";

const models = [
  {
    value: "anthropic/claude-sonnet",
    label: "Claude Sonnet",
    hint: "Anthropic",
    next: [
      { value: "default", label: "default" },
      { value: "high", label: "high" },
    ],
  },
  { value: "openai/gpt-5", label: "GPT-5", hint: "OpenAI" },
];

describe("argumentTypeaheadQuery", () => {
  it("parses a model's active model or reasoning token", () => {
    expect(argumentTypeaheadQuery("/model ant")).toEqual({
      command: "model",
      argument: "ant",
      completed: [],
      argumentStart: 7,
    });
    expect(argumentTypeaheadQuery("/model anthropic/claude-sonnet ")).toEqual({
      command: "model",
      argument: "",
      completed: ["anthropic/claude-sonnet"],
      argumentStart: 31,
    });
    expect(argumentTypeaheadQuery("/add  channel/slack")).toEqual({
      command: "add",
      argument: "channel/slack",
      completed: [],
      argumentStart: 6,
    });
    expect(argumentTypeaheadQuery("/add channel/slack ")).toBeUndefined();
    expect(argumentTypeaheadQuery("/model anthropic/claude-sonnet high ")).toBeUndefined();
    expect(argumentTypeaheadQuery("/add one two")).toBeUndefined();
    expect(argumentTypeaheadQuery("hello")).toBeUndefined();
  });
});

describe("argumentTypeaheadFor", () => {
  it("filters models, then offers their reasoning levels", () => {
    let state = argumentTypeaheadFor(
      { command: "model", argument: "anth", completed: [], argumentStart: 7 },
      models,
    );
    expect(state.suggestions).toHaveLength(1);
    expect(argumentTypeaheadCompletion(state, selectedArgumentSuggestion(state)!)).toBe(
      "/model anthropic/claude-sonnet",
    );

    state = argumentTypeaheadFor(
      {
        command: "model",
        argument: "h",
        completed: ["anthropic/claude-sonnet"],
        argumentStart: 31,
      },
      models,
    );
    expect(state.suggestions.map((suggestion) => suggestion.value)).toEqual(["high"]);
    expect(argumentTypeaheadCompletion(state, selectedArgumentSuggestion(state)!)).toBe(
      "/model anthropic/claude-sonnet high",
    );
  });

  it("preserves the selected suggestion", () => {
    let state = argumentTypeaheadFor(
      { command: "model", argument: "", completed: [], argumentStart: 7 },
      models,
    );
    state = moveArgumentTypeaheadSelection(state, 1);
    expect(selectedArgumentSuggestion(state)).toMatchObject({ value: "openai/gpt-5" });
  });

  it("sanitizes catalog text before it can render or complete", () => {
    const state = argumentTypeaheadFor(
      { command: "model", argument: "", completed: [], argumentStart: 7 },
      [{ value: "openai/\u001b]52;c;clipboard\u0007gpt", label: "GPT", hint: "\u001b[31mred" }],
    );
    expect(state.suggestions[0]).toMatchObject({ value: "openai/gpt", hint: "red" });
    expect(argumentTypeaheadCompletion(state, selectedArgumentSuggestion(state)!)).toBe(
      "/model openai/gpt",
    );
  });

  it("keeps the selected item visible in an eight-row window", () => {
    const suggestions = Array.from({ length: 9 }, (_, index) => ({
      value: `provider/model-${index}`,
      label: `Model ${index}`,
    }));
    const state = {
      ...argumentTypeaheadFor(
        { command: "model", argument: "", completed: [], argumentStart: 7 },
        suggestions,
      ),
      selectedIndex: 8,
    };
    const rows = renderArgumentSuggestions(
      state,
      createTheme({ color: false, unicode: true }),
      80,
    ).map(stripAnsi);
    expect(rows).toHaveLength(8);
    expect(rows.some((row) => row.includes("model-8"))).toBe(true);
    expect(rows.some((row) => row.includes("model-0"))).toBe(false);
  });
});
