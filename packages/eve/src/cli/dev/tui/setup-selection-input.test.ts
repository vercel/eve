import { describe, expect, it } from "vitest";

import { initialSelectState } from "#setup/cli/select-state.js";

import { reduceSetupSelectInput, setupSelectionIntent } from "./setup-selection-input.js";

describe("setupSelectionIntent", () => {
  it("shares cancellation, navigation, repaint, and submit semantics", () => {
    expect(setupSelectionIntent({ type: "escape" })).toEqual({ kind: "cancel" });
    expect(setupSelectionIntent({ type: "ctrl-c" })).toEqual({ kind: "cancel" });
    expect(setupSelectionIntent({ type: "up" })).toEqual({ kind: "move", direction: "up" });
    expect(setupSelectionIntent({ type: "down" })).toEqual({ kind: "move", direction: "down" });
    expect(setupSelectionIntent({ type: "ctrl-r" })).toEqual({ kind: "repaint" });
    expect(setupSelectionIntent({ type: "enter" })).toEqual({ kind: "submit" });
  });

  it("leaves text-editing keys to the active selection surface", () => {
    expect(setupSelectionIntent({ type: "character", value: "a" })).toBeUndefined();
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
      key: { type: "character", value: "s" },
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
});
