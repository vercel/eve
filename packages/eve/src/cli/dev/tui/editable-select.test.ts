import { describe, expect, it } from "vitest";

import { lineOf } from "./line-editor.js";
import {
  initialEditableSelectState,
  renderEditableOption,
  transitionEditableSelect,
  type EditableSelectContext,
} from "./editable-select.js";
import { createTheme } from "./theme.js";

const context: EditableSelectContext = {
  options: [
    { value: "project", label: "AI Gateway via Project" },
    { value: "own-key", label: "AI Gateway via AI_GATEWAY_API_KEY" },
  ],
  editableValue: "own-key",
  defaultValue: "",
  cancelBehavior: "cancel",
};

function editingState() {
  return initialEditableSelectState(context, "own-key");
}

function submittedState(text = "sk-live") {
  const edited = transitionEditableSelect(
    editingState(),
    { type: "edit", editor: lineOf(text) },
    context,
  );
  if (edited.kind !== "render") throw new Error("Expected an editable state.");
  const submitted = transitionEditableSelect(edited.state, { type: "submit" }, context);
  if (submitted.kind !== "validate") throw new Error("Expected validation to start.");
  return submitted;
}

describe("editable select state", () => {
  it("binds an accepted payload to the exact submitted text", () => {
    const submitted = submittedState("  sk-live  ");

    expect(submitted).toMatchObject({
      kind: "validate",
      state: { phase: { kind: "validating", text: "sk-live" } },
      text: "sk-live",
    });

    const accepted = transitionEditableSelect(
      submitted.state,
      {
        type: "validated",
        outcome: { kind: "accepted", payload: { kind: "valid" as const } },
      },
      context,
    );
    expect(accepted).toEqual({
      kind: "settle",
      result: {
        kind: "submitted",
        value: "own-key",
        text: "sk-live",
        payload: { kind: "valid" },
      },
    });
  });

  it("ignores validation completions outside the validating phase", () => {
    const stale = transitionEditableSelect(
      editingState(),
      {
        type: "validated",
        outcome: { kind: "accepted", payload: undefined },
      },
      context,
    );

    expect(stale).toEqual({ kind: "ignore", state: editingState() });
  });

  it("locks ordinary interaction while validation is pending", () => {
    const submitted = submittedState();
    const moved = transitionEditableSelect(
      submitted.state,
      { type: "move", direction: "down" },
      context,
    );

    expect(moved).toEqual({ kind: "ignore", state: submitted.state });
  });

  it("preserves an edit when navigation cannot move the cursor", () => {
    const singleRowContext: EditableSelectContext = {
      options: [{ value: "own-key", label: "AI Gateway key" }],
      editableValue: "own-key",
      defaultValue: "",
      cancelBehavior: "cancel",
    };
    const initial = initialEditableSelectState(singleRowContext, "own-key");
    const edited = transitionEditableSelect(
      initial,
      { type: "edit", editor: lineOf("sk-live") },
      singleRowContext,
    );
    if (edited.kind !== "render") throw new Error("Expected an editable state.");

    const moved = transitionEditableSelect(
      edited.state,
      { type: "move", direction: "down" },
      singleRowContext,
    );

    expect(moved).toEqual({ kind: "ignore", state: edited.state });
  });

  it("clears a non-empty opted-in editor before cancelling", () => {
    const clearFirst: EditableSelectContext = { ...context, cancelBehavior: "clear-first" };
    const edited = transitionEditableSelect(
      initialEditableSelectState(clearFirst, "own-key"),
      { type: "edit", editor: lineOf("sk-live") },
      clearFirst,
    );
    if (edited.kind !== "render") throw new Error("Expected an editable state.");

    const cleared = transitionEditableSelect(edited.state, { type: "cancel" }, clearFirst);
    expect(cleared).toMatchObject({
      kind: "clear",
      state: { phase: { kind: "editing", editor: { text: "", cursor: 0 } } },
    });
    if (cleared.kind !== "clear") throw new Error("Expected the editor to clear.");
    expect(transitionEditableSelect(cleared.state, { type: "cancel" }, clearFirst)).toEqual({
      kind: "cancel",
    });
  });

  it("returns rejected validation to an editable invalid state", () => {
    const submitted = submittedState();
    const rejected = transitionEditableSelect(
      submitted.state,
      {
        type: "validated",
        outcome: { kind: "rejected", message: "Invalid key" },
      },
      context,
    );

    expect(rejected).toMatchObject({
      kind: "render",
      state: { phase: { kind: "invalid", message: "Invalid key" } },
    });
  });

  it("submits an intentionally cleared default as empty text", () => {
    const namedContext: EditableSelectContext = {
      ...context,
      defaultValue: "weather-agent",
    };
    const initial = initialEditableSelectState(namedContext, "own-key");
    const cleared = transitionEditableSelect(
      initial,
      { type: "edit", editor: lineOf("") },
      namedContext,
    );
    if (cleared.kind !== "render") throw new Error("Expected an editable state.");

    expect(transitionEditableSelect(cleared.state, { type: "submit" }, namedContext)).toMatchObject(
      {
        kind: "validate",
        text: "",
      },
    );
  });
});

describe("renderEditableOption", () => {
  it("masks and positions the block cursor by grapheme", () => {
    const text = "e\u0301👨‍👩‍👧‍👦";
    const theme = createTheme({ color: true, unicode: true });
    const rendered = renderEditableOption(
      { value: "own-key", label: "AI Gateway key" },
      true,
      {
        optionValue: "own-key",
        mask: true,
        formatHint: (value) => value,
        phase: {
          kind: "editing",
          editor: { text, cursor: "e\u0301".length },
        },
        caretVisible: true,
      },
      theme,
    );

    expect(rendered.hint).toContain(theme.colors.inverse("•"));
    expect(rendered.hint).not.toContain(theme.glyph.caret);
  });
});
