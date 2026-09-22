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
  { value: "anthropic/claude-sonnet", label: "Claude Sonnet", hint: "Anthropic" },
  { value: "openai/gpt-5", label: "GPT-5", hint: "OpenAI" },
];

describe("argumentTypeaheadQuery", () => {
  it("recognizes one in-progress /model or /add argument", () => {
    expect(argumentTypeaheadQuery("/model ant")).toEqual({
      command: "model",
      argument: "ant",
      argumentStart: 7,
    });
    expect(argumentTypeaheadQuery("/add  channel/slack")).toEqual({
      command: "add",
      argument: "channel/slack",
      argumentStart: 6,
    });
    expect(argumentTypeaheadQuery("/model one two")).toBeUndefined();
    expect(argumentTypeaheadQuery("hello")).toBeUndefined();
  });
});

describe("argumentTypeaheadFor", () => {
  it("filters labels, values, and hints, then completes the selected value", () => {
    let state = argumentTypeaheadFor(
      { command: "model", argument: "anth", argumentStart: 7 },
      models,
    );
    expect(state.suggestions).toEqual([models[0]]);
    expect(argumentTypeaheadCompletion(state, selectedArgumentSuggestion(state)!)).toBe(
      "/model anthropic/claude-sonnet",
    );

    state = argumentTypeaheadFor({ command: "model", argument: "", argumentStart: 7 }, models);
    state = moveArgumentTypeaheadSelection(state, 1);
    expect(selectedArgumentSuggestion(state)).toEqual(models[1]);
  });

  it("sanitizes catalog text before it can render or complete", () => {
    const state = argumentTypeaheadFor({ command: "model", argument: "", argumentStart: 7 }, [
      { value: "openai/\u001b]52;c;clipboard\u0007gpt", label: "GPT", hint: "\u001b[31mred" },
    ]);
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
      ...argumentTypeaheadFor({ command: "model", argument: "", argumentStart: 7 }, suggestions),
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

  it("indents canonical values under the command argument without hints", () => {
    const rows = renderArgumentSuggestions(
      argumentTypeaheadFor({ command: "model", argument: "", argumentStart: 7 }, models),
      createTheme({ color: false, unicode: true }),
      80,
    ).map(stripAnsi);
    expect(rows[0]).toMatch(/^ {9}anthropic\/claude-sonnet$/u);
    expect(rows[1]).toMatch(/^ {9}openai\/gpt-5$/u);
    const addRows = renderArgumentSuggestions(
      argumentTypeaheadFor({ command: "add", argument: "", argumentStart: 5 }, models),
      createTheme({ color: false, unicode: true }),
      80,
    ).map(stripAnsi);
    expect(addRows[0]).toMatch(/^ {7}anthropic\/claude-sonnet$/u);
    expect(rows.join("\n")).not.toContain("Anthropic");
  });
});
