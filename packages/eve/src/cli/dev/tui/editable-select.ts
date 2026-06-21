import type { PromptOption } from "#setup/cli/index.js";
import {
  initialSelectState,
  reduceSelect,
  selectValueAtCursor,
  type SelectState,
} from "#setup/cli/select-state.js";
import type {
  EditableCancelBehavior,
  EditableSelectResult,
  EditableValidation,
} from "#setup/prompter.js";

import { EMPTY_LINE, lineOf, maskLine, visibleLine, type LineState } from "./line-editor.js";
import type { Theme } from "./theme.js";
import { renderInputText, renderInputWithBlockCursor, visibleLength } from "./terminal-text.js";

/** Fixed inputs for one editable-select interaction. */
export interface EditableSelectContext {
  options: readonly PromptOption<string>[];
  editableValue: string;
  defaultValue: string;
  cancelBehavior: EditableCancelBehavior;
}

/** The editable row's mutually exclusive interaction phases. */
export type EditableSelectPhase =
  | { kind: "inactive" }
  | { kind: "editing"; editor: LineState }
  | { kind: "validating"; editor: LineState; text: string }
  | { kind: "invalid"; editor: LineState; message: string };

/** Selection and editable-row state for one prompt. */
export interface EditableSelectState {
  select: SelectState;
  phase: EditableSelectPhase;
}

/** Semantic events after terminal-key and line-edit decoding. */
export type EditableSelectEvent<Payload> =
  | { type: "move"; direction: "up" | "down" }
  | { type: "edit"; editor: LineState }
  | { type: "cancel" }
  | { type: "submit" }
  | { type: "validated"; outcome: EditableValidation<Payload> };

/** One reducer result; terminal resources stay outside the state model. */
export type EditableSelectTransition<Payload> =
  | { kind: "ignore"; state: EditableSelectState }
  | { kind: "render"; state: EditableSelectState }
  | { kind: "clear"; state: EditableSelectState }
  | { kind: "cancel" }
  | { kind: "validate"; state: EditableSelectState; text: string }
  | { kind: "settle"; result: EditableSelectResult<string, Payload> };

function phaseForSelect(select: SelectState, context: EditableSelectContext): EditableSelectPhase {
  return selectValueAtCursor(context.options, select.cursor) === context.editableValue
    ? { kind: "editing", editor: lineOf(context.defaultValue) }
    : { kind: "inactive" };
}

/** Creates the select and inline-editor state from one initial selection. */
export function initialEditableSelectState(
  context: EditableSelectContext,
  initialValue?: string,
): EditableSelectState {
  const input: Parameters<typeof initialSelectState>[0] = { options: context.options };
  if (initialValue !== undefined) input.defaultValue = initialValue;
  const select = initialSelectState(input);
  return { select, phase: phaseForSelect(select, context) };
}

function ignore<Payload>(state: EditableSelectState): EditableSelectTransition<Payload> {
  return { kind: "ignore", state };
}

/** Advances the pure interaction state and returns one terminal command. */
export function transitionEditableSelect<Payload>(
  state: EditableSelectState,
  event: EditableSelectEvent<Payload>,
  context: EditableSelectContext,
): EditableSelectTransition<Payload> {
  if (event.type === "cancel") {
    const editor = state.phase.kind === "inactive" ? undefined : state.phase.editor;
    if (
      context.cancelBehavior === "clear-first" &&
      editor !== undefined &&
      editor.text.length > 0
    ) {
      return {
        kind: "clear",
        state: {
          select: state.select,
          phase: { kind: "editing", editor: EMPTY_LINE },
        },
      };
    }
    return { kind: "cancel" };
  }

  if (state.phase.kind === "validating") {
    if (event.type !== "validated") return ignore(state);
    if (event.outcome.kind === "rejected") {
      return {
        kind: "render",
        state: {
          select: state.select,
          phase: {
            kind: "invalid",
            editor: state.phase.editor,
            message: event.outcome.message,
          },
        },
      };
    }
    return {
      kind: "settle",
      result: {
        kind: "submitted",
        value: context.editableValue,
        text: state.phase.text,
        payload: event.outcome.payload,
      },
    };
  }

  switch (event.type) {
    case "move": {
      const select = reduceSelect(
        state.select,
        { type: event.direction },
        { options: context.options },
      );
      if (select === state.select) return ignore(state);
      return {
        kind: "render",
        state: { select, phase: phaseForSelect(select, context) },
      };
    }
    case "edit":
      if (state.phase.kind === "inactive") return ignore(state);
      return {
        kind: "render",
        state: { select: state.select, phase: { kind: "editing", editor: event.editor } },
      };
    case "submit": {
      const value = selectValueAtCursor(context.options, state.select.cursor);
      if (value === undefined) return ignore(state);
      if (value !== context.editableValue) {
        return { kind: "settle", result: { kind: "selected", value } };
      }
      if (state.phase.kind === "inactive") return ignore(state);
      const text = state.phase.editor.text.trim();
      return {
        kind: "validate",
        state: {
          select: state.select,
          phase: { kind: "validating", editor: state.phase.editor, text },
        },
        text,
      };
    }
    case "validated":
      return ignore(state);
  }
}

/** Rendering inputs for one editable option row. */
export interface SetupEditableRow {
  optionValue: string;
  cancelBehavior?: EditableCancelBehavior;
  placeholder?: string;
  mask?: boolean;
  footerHint?: string;
  inlineInvalidLabel?: string;
  formatHint: (value: string) => string;
  phase: EditableSelectPhase;
  caretVisible: boolean;
}

/** Renders only the editable option; the setup panel owns surrounding rows. */
export function renderEditableOption(
  option: PromptOption<string>,
  isCursor: boolean,
  edit: SetupEditableRow | undefined,
  theme: Theme,
  maxHintWidth = Number.POSITIVE_INFINITY,
): PromptOption<string> {
  if (!isCursor || edit?.optionValue !== option.value || edit.phase.kind === "inactive") {
    return option;
  }

  const phase = edit.phase;
  const editor = phase.editor;
  const display = edit.mask === true ? maskLine(editor) : editor;
  const cursorEnabled =
    phase.kind !== "validating" &&
    !(phase.kind === "invalid" && edit.inlineInvalidLabel !== undefined);
  const placeholder = editor.text.length === 0 ? edit.placeholder : undefined;
  const cursorLine = placeholder === undefined ? display : { text: placeholder, cursor: 0 };

  let prefix = "";
  let suffix = "";
  if (phase.kind === "validating") {
    prefix = "Validating… ";
  } else if (phase.kind === "invalid") {
    const label = edit.inlineInvalidLabel;
    if (label === undefined) {
      prefix = `${theme.colors.red(theme.glyph.error)} `;
    } else {
      const result = `${theme.glyph.error} ${theme.colors.bold(label)}`;
      suffix = `    ${theme.colors.red(result)}`;
    }
  }

  const fixedWidth = visibleLength(edit.formatHint(`${prefix}${suffix}`));
  const inputWidth = Math.max(1, maxHintWidth - fixedWidth);
  const visible = visibleLine(cursorLine, inputWidth);
  const editableValue = cursorEnabled
    ? renderInputWithBlockCursor({
        ...visible,
        visible: edit.caretVisible,
        inverse: theme.colors.inverse,
      })
    : renderInputText(`${visible.before}${visible.under}${visible.after}`);
  return { ...option, hint: edit.formatHint(`${prefix}${editableValue}${suffix}`) };
}
