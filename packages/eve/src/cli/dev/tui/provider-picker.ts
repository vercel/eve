import type { PromptOption } from "#setup/cli/index.js";
import {
  initialSelectState,
  reduceSelect,
  selectValueAtCursor,
  type SelectState,
} from "#setup/cli/select-state.js";
import type { ProviderConnection, ProviderPickerChoice } from "#setup/flows/provider.js";
import type { GatewayKeyValidation } from "#setup/validate-gateway-key.js";

import { EMPTY_LINE, type LineState } from "./line-editor.js";

/** The provider key row is either inert, editable, checking, or rejected. */
export type ProviderPickerPhase =
  | { kind: "inactive" }
  | { kind: "editing"; editor: LineState }
  | { kind: "validating"; editor: LineState; key: string }
  | { kind: "invalid"; editor: LineState; message: string };

/** One provider picker interaction: ordinary select state plus its key field. */
export interface ProviderPickerState {
  select: SelectState;
  phase: ProviderPickerPhase;
}

/** Semantic input after terminal-key and line-editor decoding. */
export type ProviderPickerEvent =
  | { type: "move"; direction: "up" | "down" }
  | { type: "edit"; editor: LineState }
  | { type: "cancel" }
  | { type: "submit" }
  | { type: "validated"; validation: GatewayKeyValidation };

/** One state transition; abort controllers remain in the terminal renderer. */
export type ProviderPickerTransition =
  | { kind: "ignore"; state: ProviderPickerState }
  | { kind: "render"; state: ProviderPickerState }
  | { kind: "clear"; state: ProviderPickerState }
  | { kind: "cancel" }
  | { kind: "validate"; state: ProviderPickerState; key: string }
  | { kind: "settle"; result: ProviderPickerChoice };

function keyPhase(
  select: SelectState,
  options: readonly PromptOption<ProviderConnection>[],
): ProviderPickerPhase {
  return selectValueAtCursor(options, select.cursor) === "own-key"
    ? { kind: "editing", editor: EMPTY_LINE }
    : { kind: "inactive" };
}

/** Creates the select and blank inline key field for one provider menu. */
export function initialProviderPickerState(
  options: readonly PromptOption<ProviderConnection>[],
  initialValue: ProviderConnection,
): ProviderPickerState {
  const select = initialSelectState({ options, defaultValue: initialValue });
  return { select, phase: keyPhase(select, options) };
}

function ignore(state: ProviderPickerState): ProviderPickerTransition {
  return { kind: "ignore", state };
}

/** Applies one provider-menu event without creating terminal resources. */
export function transitionProviderPicker(
  state: ProviderPickerState,
  event: ProviderPickerEvent,
  options: readonly PromptOption<ProviderConnection>[],
): ProviderPickerTransition {
  if (event.type === "cancel") {
    if (state.phase.kind !== "inactive" && state.phase.editor.text.length > 0) {
      return {
        kind: "clear",
        state: { select: state.select, phase: { kind: "editing", editor: EMPTY_LINE } },
      };
    }
    return { kind: "cancel" };
  }

  if (state.phase.kind === "validating") {
    if (event.type !== "validated") return ignore(state);
    if (event.validation.kind === "invalid") {
      return {
        kind: "render",
        state: {
          select: state.select,
          phase: {
            kind: "invalid",
            editor: state.phase.editor,
            message: event.validation.message,
          },
        },
      };
    }
    return {
      kind: "settle",
      result: { kind: "inline-key", key: state.phase.key, validation: event.validation },
    };
  }

  switch (event.type) {
    case "move": {
      const select = reduceSelect(state.select, { type: event.direction }, { options });
      if (select === state.select) return ignore(state);
      return { kind: "render", state: { select, phase: keyPhase(select, options) } };
    }
    case "edit":
      if (state.phase.kind === "inactive") return ignore(state);
      return {
        kind: "render",
        state: { select: state.select, phase: { kind: "editing", editor: event.editor } },
      };
    case "submit": {
      const value = selectValueAtCursor(options, state.select.cursor);
      if (value === "project" || value === "external") {
        return { kind: "settle", result: { kind: value } };
      }
      if (value !== "own-key" || state.phase.kind === "inactive") return ignore(state);
      const key = state.phase.editor.text.trim();
      if (key.length === 0) {
        return {
          kind: "render",
          state: {
            select: state.select,
            phase: {
              kind: "invalid",
              editor: state.phase.editor,
              message: "API key cannot be empty.",
            },
          },
        };
      }
      return {
        kind: "validate",
        state: {
          select: state.select,
          phase: { kind: "validating", editor: state.phase.editor, key },
        },
        key,
      };
    }
    case "validated":
      return ignore(state);
  }
}
