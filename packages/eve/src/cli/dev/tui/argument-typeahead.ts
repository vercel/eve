import { sliceVisible, visibleLength } from "#cli/ui/terminal-text.js";
import { renderCursorRow } from "#setup/cli/option-row.js";

import type { Theme } from "./theme.js";

export interface PromptArgumentSuggestion {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

export interface ArgumentTypeaheadState {
  readonly command: "model" | "add";
  readonly query: string;
  readonly suggestions: readonly PromptArgumentSuggestion[];
  readonly selectedIndex: number;
}

/** Returns the command and its single-token argument while it is being composed. */
export function argumentTypeaheadQuery(
  text: string,
): Pick<ArgumentTypeaheadState, "command" | "query"> | undefined {
  const match = /^\/(model|add)\s+([^\s]*)$/u.exec(text);
  if (match === null) return undefined;
  return { command: match[1]! as ArgumentTypeaheadState["command"], query: match[2]! };
}

/** Filters catalog entries case-insensitively across their visible labels and ids. */
export function argumentTypeaheadFor(
  command: ArgumentTypeaheadState["command"],
  query: string,
  suggestions: readonly PromptArgumentSuggestion[],
  previous?: ArgumentTypeaheadState,
): ArgumentTypeaheadState {
  const normalized = query.toLowerCase();
  const matches = suggestions.filter(
    (suggestion) =>
      suggestion.value.toLowerCase().includes(normalized) ||
      suggestion.label.toLowerCase().includes(normalized) ||
      (suggestion.hint?.toLowerCase().includes(normalized) ?? false),
  );
  const selected = previous?.suggestions[previous.selectedIndex];
  const selectedIndex = selected === undefined ? -1 : matches.indexOf(selected);
  return {
    command,
    query,
    suggestions: matches,
    selectedIndex: selectedIndex >= 0 ? selectedIndex : 0,
  };
}

export function moveArgumentTypeaheadSelection(
  state: ArgumentTypeaheadState,
  delta: 1 | -1,
): ArgumentTypeaheadState {
  if (state.suggestions.length === 0) return state;
  return {
    ...state,
    selectedIndex:
      (state.selectedIndex + delta + state.suggestions.length) % state.suggestions.length,
  };
}

export function selectedArgumentSuggestion(
  state: ArgumentTypeaheadState,
): PromptArgumentSuggestion | undefined {
  return state.suggestions[state.selectedIndex];
}

/** Replaces the current argument, leaving the command ready to submit. */
export function argumentTypeaheadCompletion(
  state: ArgumentTypeaheadState,
  suggestion: PromptArgumentSuggestion,
): string {
  return `/${state.command} ${suggestion.value}`;
}

/** Paints compact catalog rows using the slash-menu selection grammar. */
export function renderArgumentSuggestions(
  state: ArgumentTypeaheadState,
  theme: Theme,
  width: number,
): string[] {
  const c = theme.colors;
  return state.suggestions.slice(0, 8).map((suggestion, index) => {
    const selected = index === state.selectedIndex;
    const content = selected
      ? `${theme.glyph.selectedPointer} ${suggestion.label}`
      : `  ${suggestion.label}`;
    const row = `${renderCursorRow(content, selected, c)}${
      suggestion.hint === undefined ? "" : `  ${c.dim(suggestion.hint)}`
    }`;
    return visibleLength(row) > width ? sliceVisible(row, width) : row;
  });
}
