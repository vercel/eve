import { describe, expect, it } from "vitest";

import { initialSelectState } from "#setup/cli/select-state.js";

import { reduceSetupSelectInput, setupSelectionIntent } from "./setup-selection-input.js";

describe("setupSelectionIntent", () => {
  it("splits Esc (back one step) from Ctrl-C (cancel) and shares the rest", () => {
    // Esc steps back; Ctrl-C cancels the whole flow. They diverged once
    // back-navigation existed — before, both meant cancel.
    expect(setupSelectionIntent({ type: "escape" })).toEqual({ kind: "back" });
    expect(setupSelectionIntent({ type: "ctrl-c" })).toEqual({ kind: "cancel" });
    expect(setupSelectionIntent({ type: "up" })).toEqual({ kind: "move", direction: "up" });
    expect(setupSelectionIntent({ type: "down" })).toEqual({ kind: "move", direction: "down" });
    expect(setupSelectionIntent({ type: "ctrl-r" })).toEqual({ kind: "repaint" });
    expect(setupSelectionIntent({ type: "enter" })).toEqual({ kind: "submit" });
  });

  it("reduces Esc to a back result and Ctrl-C to a cancel result", () => {
    const options = [{ value: "web", label: "Web Chat" }];
    const select = initialSelectState({ options });
    expect(
      reduceSetupSelectInput({ key: { type: "escape" }, kind: "single", options, select }),
    ).toEqual({ kind: "back" });
    expect(
      reduceSetupSelectInput({ key: { type: "ctrl-c" }, kind: "single", options, select }),
    ).toEqual({ kind: "cancel" });
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
    const select = initialSelectState({ options, trailingRow: "submit" });
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

  it("returns a nonblank zero-match query for a query-capable search", () => {
    const options = [{ value: "alpha", label: "Alpha" }];
    const select = initialSelectState({ options, filter: "inbound" });

    expect(
      reduceSetupSelectInput({
        key: { type: "enter" },
        kind: "query-search",
        options,
        select,
      }),
    ).toEqual({ kind: "query", query: "inbound" });
  });

  it("moves from a partial local match to the external query action", () => {
    const options = [{ value: "alpha-local", label: "Alpha local" }];
    const select = initialSelectState({ options, filter: "alpha" });
    const moved = reduceSetupSelectInput({
      key: { type: "down" },
      kind: "query-search",
      options,
      select,
    });

    expect(moved).toEqual({ kind: "update", select: { ...select, cursor: 1 } });
    if (moved.kind !== "update") return;
    expect(
      reduceSetupSelectInput({
        key: { type: "enter" },
        kind: "query-search",
        options,
        select: moved.select,
      }),
    ).toEqual({ kind: "query", query: "alpha" });
  });
});
