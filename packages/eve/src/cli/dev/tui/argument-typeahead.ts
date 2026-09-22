import { sliceVisible, visibleLength } from "#cli/ui/terminal-text.js";

import type { Theme } from "./theme.js";

export interface PromptArgumentSuggestion {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

export interface ArgumentTypeaheadQuery {
  readonly command: "model" | "add";
  readonly argument: string;
  /** Offset of the argument in the composer draft. */
  readonly argumentStart: number;
}

export interface ArgumentTypeaheadState extends ArgumentTypeaheadQuery {
  readonly suggestions: readonly PromptArgumentSuggestion[];
  readonly selectedIndex: number;
}

/**
 * Parses one supported slash command and its unfinished single-token argument.
 * Keeping this deliberately small makes the inline picker independent of the
 * execution parser while preserving the exact composer offsets it needs.
 */
export function argumentTypeaheadQuery(text: string): ArgumentTypeaheadQuery | undefined {
  if (!text.startsWith("/")) return undefined;
  const separator = text.indexOf(" ");
  if (separator < 0) return undefined;
  const command = text.slice(1, separator);
  if (command !== "model" && command !== "add") return undefined;

  let argumentStart = separator;
  while (text[argumentStart] === " ") argumentStart += 1;
  const argument = text.slice(argumentStart);
  return [...argument].some((character) => character.trim().length === 0)
    ? undefined
    : { command, argument, argumentStart };
}

/** Filters catalog entries case-insensitively across their visible labels and ids. */
export function argumentTypeaheadFor(
  query: ArgumentTypeaheadQuery,
  suggestions: readonly PromptArgumentSuggestion[],
  previous?: ArgumentTypeaheadState,
): ArgumentTypeaheadState {
  const normalized = query.argument.toLowerCase();
  const matches = suggestions.filter(
    (suggestion) =>
      suggestion.value.toLowerCase().includes(normalized) ||
      suggestion.label.toLowerCase().includes(normalized) ||
      (suggestion.hint?.toLowerCase().includes(normalized) ?? false),
  );
  const selected = previous?.suggestions[previous.selectedIndex];
  const selectedIndex = selected === undefined ? -1 : matches.indexOf(selected);
  return {
    ...query,
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

/** Paints canonical catalog values under the command's argument column. */
export function renderArgumentSuggestions(
  state: ArgumentTypeaheadState,
  theme: Theme,
  width: number,
): string[] {
  const c = theme.colors;
  return state.suggestions.slice(0, 8).map((suggestion, index) => {
    const value =
      index === state.selectedIndex ? c.bold(suggestion.value) : c.dim(suggestion.value);
    const indent = " ".repeat(state.argumentStart + 2);
    const row = `${indent}${value}`;
    return visibleLength(row) > width ? sliceVisible(row, width) : row;
  });
}
