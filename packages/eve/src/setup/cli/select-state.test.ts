import { describe, expect, it } from "vitest";

import type { PromptOption } from "./prompt-ui.js";
import {
  filterOptions,
  initialSelectState,
  orderedSelection,
  reduceSelect,
  selectValueAtCursor,
  type SelectContext,
  type SelectState,
} from "./select-state.js";

const OPTIONS: PromptOption<string>[] = [
  { value: "anthropic/claude", label: "Claude", hint: "Anthropic" },
  { value: "openai/gpt", label: "GPT", hint: "OpenAI" },
  { value: "google/gemini", label: "Gemini", hint: "Google" },
];

const initial: SelectState = { filter: "", cursor: 0, selected: new Set() };

function context(overrides: Partial<SelectContext> = {}): SelectContext {
  return { options: OPTIONS, ...overrides };
}

describe("filterOptions", () => {
  it("returns every option for an empty filter", () => {
    expect(filterOptions(OPTIONS, "")).toHaveLength(3);
    expect(filterOptions(OPTIONS, "   ")).toHaveLength(3);
  });

  it("matches case-insensitively against label, value, and hint", () => {
    expect(filterOptions(OPTIONS, "CLAUDE").map((o) => o.value)).toEqual(["anthropic/claude"]);
    expect(filterOptions(OPTIONS, "openai").map((o) => o.value)).toEqual(["openai/gpt"]);
    expect(filterOptions(OPTIONS, "google").map((o) => o.value)).toEqual(["google/gemini"]);
  });

  it("matches focus-only hints", () => {
    const options: PromptOption<string>[] = [
      {
        value: "web",
        label: "Web Chat",
        completed: true,
        focusHint: "Already installed",
      },
    ];
    expect(filterOptions(options, "installed")).toEqual(options);
  });

  it("returns nothing when no option matches", () => {
    expect(filterOptions(OPTIONS, "zzz")).toEqual([]);
  });

  it("keeps featured options out of filtering: an empty query still returns the full list", () => {
    const options: PromptOption<string>[] = [
      { value: "anthropic/claude", label: "Claude", featured: true },
      { value: "openai/gpt", label: "GPT" },
      { value: "google/gemini", label: "Gemini" },
    ];
    // featured shapes the searchable viewport, not which rows the cursor can reach.
    expect(filterOptions(options, "")).toHaveLength(3);
    expect(filterOptions(options, "g").map((o) => o.value)).toEqual([
      "openai/gpt",
      "google/gemini",
    ]);
  });

  it("matches queries containing spaces", () => {
    const options: PromptOption<string>[] = [
      { value: "a", label: "Claude Sonnet 4.6" },
      { value: "b", label: "Claude Opus 4.8" },
    ];
    expect(filterOptions(options, "claude s").map((o) => o.value)).toEqual(["a"]);
  });
});

describe("reduceSelect", () => {
  it("appends typed characters and re-homes the cursor", () => {
    const next = reduceSelect({ ...initial, cursor: 2 }, { type: "char", char: "g" }, context());
    expect(next.filter).toBe("g");
    expect(next.cursor).toBe(0);
  });

  it("keeps marked values while the query changes", () => {
    const marked: SelectState = { filter: "", cursor: 0, selected: new Set(["openai/gpt"]) };
    expect([...reduceSelect(marked, { type: "char", char: "x" }, context()).selected]).toEqual([
      "openai/gpt",
    ]);
  });

  it("backspaces one grapheme and ignores an empty filter", () => {
    expect(reduceSelect(initial, { type: "backspace" }, context())).toBe(initial);
    const state = { filter: "😀", cursor: 0, selected: new Set<string>() };
    expect(reduceSelect(state, { type: "backspace" }, context()).filter).toBe("");
  });

  it("wraps the cursor across the visible list", () => {
    expect(reduceSelect(initial, { type: "up" }, context()).cursor).toBe(2);
    expect(reduceSelect({ ...initial, cursor: 2 }, { type: "down" }, context()).cursor).toBe(0);
  });

  it("skips disabled entries while navigating", () => {
    const ctx = context({
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B", disabled: true },
        { value: "c", label: "C" },
      ],
    });
    expect(reduceSelect({ ...initial, cursor: 0 }, { type: "down" }, ctx).cursor).toBe(2);
    expect(reduceSelect({ ...initial, cursor: 0 }, { type: "up" }, ctx).cursor).toBe(2);
  });

  it("lets the cursor focus completed entries", () => {
    const ctx = context({
      options: [
        { value: "installed", label: "Installed", completed: true },
        { value: "available", label: "Available" },
      ],
    });
    expect(reduceSelect({ ...initial, cursor: 1 }, { type: "up" }, ctx).cursor).toBe(0);
  });

  it("does not move the cursor when nothing is visible", () => {
    const state = { ...initial, filter: "zzz" };
    expect(reduceSelect(state, { type: "down" }, context())).toBe(state);
  });

  it("toggles the highlighted entry into and out of the marked set", () => {
    const marked = reduceSelect({ ...initial, cursor: 1 }, { type: "toggle" }, context());
    expect([...marked.selected]).toEqual(["openai/gpt"]);
    expect([...reduceSelect(marked, { type: "toggle" }, context()).selected]).toEqual([]);
  });

  it("does not toggle a disabled entry", () => {
    const ctx = context({ options: [{ value: "a", label: "A", disabled: true }] });
    expect(reduceSelect(initial, { type: "toggle" }, ctx).selected.size).toBe(0);
  });

  it("does not toggle a completed entry", () => {
    const ctx = context({
      options: [{ value: "installed", label: "Installed", completed: true }],
    });
    expect(reduceSelect(initial, { type: "toggle" }, ctx).selected.size).toBe(0);
  });

  it("skips locked entries while navigating", () => {
    const ctx = context({
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B", locked: true },
        { value: "c", label: "C" },
      ],
    });
    expect(reduceSelect({ ...initial, cursor: 0 }, { type: "down" }, ctx).cursor).toBe(2);
    expect(reduceSelect({ ...initial, cursor: 0 }, { type: "up" }, ctx).cursor).toBe(2);
  });

  it("does not unmark a locked entry", () => {
    const ctx = context({ options: [{ value: "a", label: "A", locked: true }] });
    const seeded: SelectState = { filter: "", cursor: 0, selected: new Set(["a"]) };
    expect([...reduceSelect(seeded, { type: "toggle" }, ctx).selected]).toEqual(["a"]);
  });

  it("includes the Submit row in the navigation cycle when enabled", () => {
    const ctx = context({ submitRow: true });
    // Down from the last option lands on the Submit row (one past the options).
    expect(reduceSelect({ ...initial, cursor: 2 }, { type: "down" }, ctx).cursor).toBe(3);
    // Down from the Submit row wraps back to the first option.
    expect(reduceSelect({ ...initial, cursor: 3 }, { type: "down" }, ctx).cursor).toBe(0);
    // Up from the first option wraps onto the Submit row.
    expect(reduceSelect({ ...initial, cursor: 0 }, { type: "up" }, ctx).cursor).toBe(3);
  });

  it("ignores toggle on the Submit row", () => {
    const ctx = context({ submitRow: true });
    const state: SelectState = { filter: "", cursor: 3, selected: new Set(["openai/gpt"]) };
    expect([...reduceSelect(state, { type: "toggle" }, ctx).selected]).toEqual(["openai/gpt"]);
  });

  it("re-homes onto the Submit row when a filter hides every option", () => {
    const next = reduceSelect(initial, { type: "char", char: "z" }, context({ submitRow: true }));
    // No visible options, so the Submit row index is 0.
    expect(next.cursor).toBe(0);
    expect(selectValueAtCursor(filterOptions(OPTIONS, next.filter), next.cursor)).toBeUndefined();
  });
});

describe("initialSelectState", () => {
  it("homes the cursor on a matching default", () => {
    expect(initialSelectState({ options: OPTIONS, defaultValue: "google/gemini" })).toEqual({
      filter: "",
      cursor: 2,
      selected: new Set(),
    });
  });

  it("falls back to the first selectable entry without a default", () => {
    const state = initialSelectState({
      options: [
        { value: "a", label: "A", disabled: true },
        { value: "b", label: "B" },
      ],
    });
    expect(state.cursor).toBe(1);
  });

  it("seeds the marked set from initialValues", () => {
    expect([
      ...initialSelectState({ options: OPTIONS, initialValues: ["openai/gpt"] }).selected,
    ]).toEqual(["openai/gpt"]);
  });

  it("seeds locked options as selected and skips them with the cursor", () => {
    const state = initialSelectState({
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B", locked: true },
      ],
    });
    expect([...state.selected]).toEqual(["b"]);
    expect(state.cursor).toBe(0);
  });

  it("homes onto the Submit row when every option is disabled", () => {
    const state = initialSelectState({
      options: [
        { value: "a", label: "A", disabled: true },
        { value: "b", label: "B", disabled: true },
      ],
      submitRow: true,
    });
    expect(state.cursor).toBe(2);
  });

  it("merges locked options with initialValues", () => {
    const state = initialSelectState({
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B", locked: true },
      ],
      initialValues: ["a"],
    });
    expect([...state.selected].sort()).toEqual(["a", "b"]);
  });
});

describe("selectValueAtCursor / orderedSelection", () => {
  it("reads the highlighted value, or undefined when it is not actionable", () => {
    expect(selectValueAtCursor(OPTIONS, 1)).toBe("openai/gpt");
    expect(selectValueAtCursor([{ value: "a", label: "A", disabled: true }], 0)).toBeUndefined();
    expect(selectValueAtCursor([{ value: "a", label: "A", locked: true }], 0)).toBeUndefined();
    expect(selectValueAtCursor([{ value: "a", label: "A", completed: true }], 0)).toBeUndefined();
  });

  it("orders the marked set to match the option list", () => {
    expect(orderedSelection(OPTIONS, new Set(["google/gemini", "anthropic/claude"]))).toEqual([
      "anthropic/claude",
      "google/gemini",
    ]);
  });
});
