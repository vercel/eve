import { describe, expect, it } from "vitest";

import { initialSelectState } from "#setup/cli/select-state.js";

import { reduceSetupSelectInput, setupSelectionIntent } from "./setup-selection-input.js";

describe("setupSelectionIntent", () => {
  it("shares cancellation, navigation, repaint, and submit semantics", () => {
    expect(setupSelectionIntent({ type: "escape" })).toEqual({ kind: "cancel" });
    expect(setupSelectionIntent({ type: "ctrl-c" })).toEqual({ kind: "cancel" });
    expect(setupSelectionIntent({ type: "up" })).toEqual({ kind: "move", direction: "up" });
    expect(setupSelectionIntent({ type: "down" })).toEqual({ kind: "move", direction: "down" });
    expect(setupSelectionIntent({ type: "ctrl-p" })).toEqual({ kind: "move", direction: "up" });
    expect(setupSelectionIntent({ type: "ctrl-n" })).toEqual({ kind: "move", direction: "down" });
    expect(setupSelectionIntent({ type: "ctrl-r" })).toEqual({ kind: "repaint" });
    expect(setupSelectionIntent({ type: "enter" })).toEqual({ kind: "submit" });
  });

  it("leaves text-editing keys to the active selection surface", () => {
    expect(setupSelectionIntent({ type: "text", value: "a", framing: "unframed" })).toBeUndefined();
    expect(setupSelectionIntent({ type: "backspace" })).toBeUndefined();
  });

  it("submits single selects and ignores completed rows", () => {
    const options = [
      { value: "done", label: "Done", completed: true },
      { value: "web", label: "Web Chat" },
    ];
    const completed = initialSelectState({ options });
    expect(
      reduceSetupSelectInput({
        key: { type: "enter" },
        kind: "single",
        options,
        select: completed,
      }),
    ).toEqual({ kind: "ignore" });

    expect(
      reduceSetupSelectInput({
        key: { type: "enter" },
        kind: "single",
        options,
        select: { ...completed, cursor: 1 },
      }),
    ).toEqual({ kind: "submit", values: ["web"] });
  });

  it("requires a marked value before submitting a required multi-select", () => {
    const options = [{ value: "web", label: "Web Chat" }];
    const select = initialSelectState({ options, submitRow: true });
    expect(
      reduceSetupSelectInput({
        key: { type: "enter" },
        kind: "multi",
        options,
        select: { ...select, cursor: 1 },
        required: true,
      }),
    ).toEqual({ kind: "error", message: "Select at least one option, then submit." });
  });

  it("applies filter text and submits the visible match", () => {
    const options = [
      { value: "web", label: "Web Chat" },
      { value: "slack", label: "Slack" },
    ];
    const initial = initialSelectState({ options });
    const filtered = reduceSetupSelectInput({
      key: { type: "text", value: "s", framing: "unframed" },
      kind: "search",
      options,
      select: initial,
    });
    expect(filtered.kind).toBe("update");
    if (filtered.kind !== "update") return;
    expect(filtered.select.filter).toBe("s");
    expect(
      reduceSetupSelectInput({
        key: { type: "enter" },
        kind: "search",
        options,
        select: filtered.select,
      }),
    ).toEqual({ kind: "submit", values: ["slack"] });
  });

  it("clears a searchable filter with escape before cancelling the panel", () => {
    const options = [
      { value: "recent", label: "recent-agent" },
      { value: "older", label: "older-agent" },
    ];
    const searched = initialSelectState({ options, filter: "older" });

    expect(
      reduceSetupSelectInput({
        key: { type: "escape" },
        kind: "search",
        options,
        select: searched,
      }),
    ).toMatchObject({ kind: "update", select: { filter: "", cursor: 0 } });
    expect(
      reduceSetupSelectInput({
        key: { type: "escape" },
        kind: "search",
        options,
        select: initialSelectState({ options }),
      }),
    ).toEqual({ kind: "cancel" });
  });

  it("applies bracketed-paste text to searchable fields", () => {
    const options = [
      { value: "new-york", label: "New York" },
      { value: "boston", label: "Boston" },
    ];
    const result = reduceSetupSelectInput({
      key: { type: "text", value: "Boston", framing: "bracketed-paste" },
      kind: "search",
      options,
      select: initialSelectState({ options }),
    });

    expect(result.kind).toBe("update");
    if (result.kind !== "update") return;
    expect(result.select.filter).toBe("Boston");
  });

  it("does not turn a pasted space into a multi-select toggle", () => {
    const options = [{ value: "web", label: "Web Chat" }];
    const select = initialSelectState({ options, submitRow: true });

    expect(
      reduceSetupSelectInput({
        key: { type: "text", value: " ", framing: "bracketed-paste" },
        kind: "multi",
        options,
        select,
        required: false,
      }),
    ).toEqual({ kind: "ignore" });
  });
});
