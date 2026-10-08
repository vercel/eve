import type { PromptOption } from "#setup/cli/index.js";
import {
  reduceSelect,
  submitSelect,
  type SearchActionOption,
  type SelectContext,
  type SelectState,
} from "#setup/cli/select-state.js";

import type { TerminalKey } from "./stream-format.js";

/** Shared navigation grammar for setup selects, actions, and editable selects. */
type SetupSelectionIntent =
  | { kind: "cancel" }
  | { kind: "move"; direction: "up" | "down" }
  | { kind: "repaint" }
  | { kind: "submit" };

/** Maps terminal keys to the intents every setup selection surface shares. */
export function setupSelectionIntent(
  key: TerminalKey,
  options: { textNavigation?: boolean } = {},
): SetupSelectionIntent | undefined {
  if (options.textNavigation && key.type === "text" && key.framing === "unframed") {
    if (key.value === "k") return { kind: "move", direction: "up" };
    if (key.value === "j") return { kind: "move", direction: "down" };
  }

  switch (key.type) {
    case "ctrl-c":
    case "escape":
      return { kind: "cancel" };
    case "up":
    case "ctrl-p":
      return { kind: "move", direction: "up" };
    case "down":
    case "ctrl-n":
      return { kind: "move", direction: "down" };
    case "ctrl-r":
      return { kind: "repaint" };
    case "enter":
      return { kind: "submit" };
    default:
      return undefined;
  }
}

type SetupSelectInputResult =
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
  plannerNavigation?: true;
};

type SetupSelectInputState = SetupSingleSelectInput | SetupMultiSelectInput;

function isMultiSelect(input: SetupSelectInputState): input is SetupMultiSelectInput {
  return input.kind === "multi" || input.kind === "searchable-multi";
}

function isSearchableSelect(input: SetupSelectInputState): boolean {
  return input.kind === "search" || input.kind === "searchable-multi";
}

function selectContext(input: SetupSelectInputState): SelectContext {
  return {
    options: input.options,
    searchAction: input.searchAction,
    submitRow: isMultiSelect(input) && input.plannerNavigation !== true,
  };
}

function updatedSelect(
  input: SetupSelectInputState,
  event: Parameters<typeof reduceSelect>[1],
): SetupSelectInputResult {
  return { kind: "update", select: reduceSelect(input.select, event, selectContext(input)) };
}

function submitSetupSelect(input: SetupSelectInputState): SetupSelectInputResult {
  const submission = submitSelect(input.select, {
    ...selectContext(input),
    multiple: isMultiSelect(input),
    required: isMultiSelect(input) && input.required,
  });
  return submission.kind === "toggle" ? updatedSelect(input, { type: "toggle" }) : submission;
}

function editSetupSelect(input: SetupSelectInputState): SetupSelectInputResult {
  switch (input.key.type) {
    case "backspace":
      return isSearchableSelect(input)
        ? updatedSelect(input, { type: "backspace" })
        : { kind: "ignore" };
    case "alt-backspace":
      return isSearchableSelect(input)
        ? updatedSelect(input, { type: "delete-word-backward" })
        : { kind: "ignore" };
    case "text": {
      if (input.key.framing === "unframed" && isMultiSelect(input) && input.key.value === " ") {
        return updatedSelect(input, { type: "toggle" });
      }
      if (!isSearchableSelect(input)) return { kind: "ignore" };

      let select = input.select;
      const context = selectContext(input);
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
  const intent = setupSelectionIntent(input.key, { textNavigation: !isSearchableSelect(input) });
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
