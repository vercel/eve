import { sanitizeForTerminal } from "#cli/ui/output.js";
import { sliceVisible, visibleLength } from "#cli/ui/terminal-text.js";

import type { Theme } from "./theme.js";

export interface PromptArgumentSuggestion {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
  /** Follow-up values available after selecting this exact value. */
  readonly next?: readonly PromptArgumentSuggestion[];
}

export interface ArgumentTypeaheadQuery {
  readonly command: "model" | "add";
  readonly argument: string;
  /** Complete arguments before the one currently being typed. */
  readonly completed: readonly string[];
  /** Offset of the current argument in the composer draft. */
  readonly argumentStart: number;
}

export interface ArgumentTypeaheadState extends ArgumentTypeaheadQuery {
  readonly suggestions: readonly PromptArgumentSuggestion[];
  readonly selectedIndex: number;
}

/**
 * Parses the current argument in one supported slash command. `/model` accepts
 * a second token for reasoning; `/add` accepts only its registry address.
 */
export function argumentTypeaheadQuery(text: string): ArgumentTypeaheadQuery | undefined {
  if (!text.startsWith("/")) return undefined;
  const separator = text.indexOf(" ");
  if (separator < 0) return undefined;
  const command = text.slice(1, separator);
  if (command !== "model" && command !== "add") return undefined;

  const tail = text.slice(separator + 1);
  const leadingSpaces = tail.length - tail.trimStart().length;
  const tokens = tail.slice(leadingSpaces).split(" ");
  if (tail.length > 0 && tokens.some((token) => token.length === 0) && !tail.endsWith(" ")) {
    return undefined;
  }
  const completed = tokens.slice(0, -1).filter(Boolean);
  const argument = tokens.at(-1) ?? "";
  if (
    (command === "add" && completed.length > 0) ||
    (command === "model" && completed.length > 1)
  ) {
    return undefined;
  }
  const argumentStart = text.length - argument.length;
  return { command, argument, completed, argumentStart };
}

function sanitizeSuggestion(suggestion: PromptArgumentSuggestion): PromptArgumentSuggestion {
  return {
    value: sanitizeForTerminal(suggestion.value),
    label: sanitizeForTerminal(suggestion.label),
    ...(suggestion.hint === undefined ? {} : { hint: sanitizeForTerminal(suggestion.hint) }),
    ...(suggestion.next === undefined ? {} : { next: suggestion.next.map(sanitizeSuggestion) }),
  };
}

/** Filters catalog entries case-insensitively across their visible labels and ids. */
export function argumentTypeaheadFor(
  query: ArgumentTypeaheadQuery,
  catalog: readonly PromptArgumentSuggestion[],
  previous?: ArgumentTypeaheadState,
): ArgumentTypeaheadState {
  const root = catalog.map(sanitizeSuggestion);
  const candidates =
    query.completed.length === 0
      ? root
      : (root.find((suggestion) => suggestion.value === query.completed[0])?.next ?? []);
  const normalized = query.argument.toLowerCase();
  const suggestions = candidates.filter(
    (suggestion) =>
      suggestion.value.toLowerCase().includes(normalized) ||
      suggestion.label.toLowerCase().includes(normalized) ||
      (suggestion.hint?.toLowerCase().includes(normalized) ?? false),
  );
  const selected = previous?.suggestions[previous.selectedIndex];
  const selectedIndex =
    selected === undefined ? -1 : suggestions.findIndex((item) => item.value === selected.value);
  return { ...query, suggestions, selectedIndex: selectedIndex >= 0 ? selectedIndex : 0 };
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

/** Replaces only the active argument, retaining selected preceding model tokens. */
export function argumentTypeaheadCompletion(
  state: ArgumentTypeaheadState,
  suggestion: PromptArgumentSuggestion,
): string {
  return `/${state.command} ${[...state.completed, suggestion.value].join(" ")}`;
}

/** Paints canonical catalog values under the command's active argument column. */
export function renderArgumentSuggestions(
  state: ArgumentTypeaheadState,
  theme: Theme,
  width: number,
): string[] {
  const c = theme.colors;
  const viewSize = Math.min(8, state.suggestions.length);
  const start = Math.max(
    0,
    Math.min(state.selectedIndex - Math.floor(viewSize / 2), state.suggestions.length - viewSize),
  );
  return state.suggestions.slice(start, start + viewSize).map((suggestion, index) => {
    const value =
      start + index === state.selectedIndex ? c.bold(suggestion.value) : c.dim(suggestion.value);
    const row = `${" ".repeat(state.argumentStart + 2)}${value}`;
    return visibleLength(row) > width ? sliceVisible(row, width) : row;
  });
}
