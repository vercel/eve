import type { PromptOption } from "#setup/cli/index.js";
import {
  filterOptions,
  orderedSelection,
  reduceSelect,
  selectValueAtCursor,
  submitRowIndex,
  type SearchActionOption,
  type SelectState,
} from "#setup/cli/select-state.js";

import type { TerminalKey } from "./stream-format.js";

/** Shared navigation grammar for setup selects, actions, and editable selects. */
export type SetupSelectionIntent =
  | { kind: "cancel" }
  | { kind: "move"; direction: "up" | "down" }
  | { kind: "repaint" }
  | { kind: "submit" };

/** Maps terminal keys to the intents every setup selection surface shares. */
export function setupSelectionIntent(key: TerminalKey): SetupSelectionIntent | undefined {
  switch (key.type) {
    case "ctrl-c":
    case "escape":
      return { kind: "cancel" };
    case "up":
      return { kind: "move", direction: "up" };
    case "down":
      return { kind: "move", direction: "down" };
    case "ctrl-r":
      return { kind: "repaint" };
    case "enter":
      return { kind: "submit" };
    default:
      return undefined;
  }
}

export type SetupSelectInputResult =
  | { kind: "cancel" }
  | { kind: "repaint" }
  | { kind: "update"; select: SelectState }
  | { kind: "submit"; values: readonly string[] }
  | { kind: "error"; message: string }
  | { kind: "ignore" };

interface SetupSelectInput {
  key: TerminalKey;
  options: readonly PromptOption<string>[];
  searchAction?: SearchActionOption;
  select: SelectState;
}

type SetupSingleSelectInput = SetupSelectInput & {
  kind: "single" | "stacked" | "task-list" | "search";
};

type SetupMultiSelectInput = SetupSelectInput & {
  kind: "multi" | "searchable-multi";
  required: boolean;
};

type SetupSelectInputState = SetupSingleSelectInput | SetupMultiSelectInput;

function isMultiSelect(input: SetupSelectInputState): input is SetupMultiSelectInput {
  return input.kind === "multi" || input.kind === "searchable-multi";
}

function isSearchableSelect(input: SetupSelectInputState): boolean {
  return input.kind === "search" || input.kind === "searchable-multi";
}

function updatedSelect(
  input: SetupSelectInputState,
  event: Parameters<typeof reduceSelect>[1],
): SetupSelectInputResult {
  return {
    kind: "update",
    select: reduceSelect(input.select, event, {
      options: input.options,
      searchAction: input.searchAction,
      submitRow: isMultiSelect(input),
    }),
  };
}

function submitSetupSelect(input: SetupSelectInputState): SetupSelectInputResult {
  const visible = isSearchableSelect(input)
    ? filterOptions(input.options, input.select.filter, input.searchAction)
    : [...input.options];
  if (isMultiSelect(input)) {
    if (input.select.cursor !== submitRowIndex(visible)) {
      return updatedSelect(input, { type: "toggle" });
    }
    if (input.required && input.select.selected.size === 0) {
      return { kind: "error", message: "Select at least one option, then submit." };
    }
    return {
      kind: "submit",
      values: orderedSelection(input.options, input.select.selected),
    };
  }

  const value = selectValueAtCursor(visible, input.select.cursor);
  if (value !== undefined) return { kind: "submit", values: [value] };
  if (visible[input.select.cursor]?.completed) return { kind: "ignore" };
  return { kind: "error", message: "Type to match an option, then press enter." };
}

function editSetupSelect(input: SetupSelectInputState): SetupSelectInputResult {
  switch (input.key.type) {
    case "backspace":
      return isSearchableSelect(input)
        ? updatedSelect(input, { type: "backspace" })
        : { kind: "ignore" };
    case "text": {
      if (input.key.framing === "unframed" && isMultiSelect(input) && input.key.value === " ") {
        return updatedSelect(input, { type: "toggle" });
      }
      if (!isSearchableSelect(input)) return { kind: "ignore" };

      let select = input.select;
      const context = {
        options: input.options,
        searchAction: input.searchAction,
        submitRow: isMultiSelect(input),
      };
      for (const char of input.key.value.replaceAll("\n", " ")) {
        if (char >= " " && char !== "\u007f") {
          select = reduceSelect(select, { type: "char", char }, context);
        }
      }
      return { kind: "update", select };
    }
    default:
      return { kind: "ignore" };
  }
}

/** Pure key transition for a setup select; rendering and lifecycle stay outside. */
export function reduceSetupSelectInput(input: SetupSelectInputState): SetupSelectInputResult {
  const intent = setupSelectionIntent(input.key);
  switch (intent?.kind) {
    case "cancel":
      if (
        input.key.type === "escape" &&
        isSearchableSelect(input) &&
        input.select.filter.length > 0
      ) {
        return updatedSelect(input, { type: "clear" });
      }
      return { kind: "cancel" };
    case "repaint":
      return { kind: "repaint" };
    case "move":
      return updatedSelect(input, { type: intent.direction });
    case "submit":
      return submitSetupSelect(input);
    case undefined:
      return editSetupSelect(input);
  }
}
