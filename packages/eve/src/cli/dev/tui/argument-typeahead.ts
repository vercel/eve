import { sanitizeForTerminal } from "#cli/ui/output.js";
import { sliceVisible, visibleLength } from "#cli/ui/terminal-text.js";

import { PROMPT_COMMANDS, type ArgumentTypeaheadCommand } from "./prompt-commands.js";
import type { Theme } from "./theme.js";

export interface PromptArgumentSuggestion {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
  /** Follow-up values available after selecting this exact value. */
  readonly next?: readonly PromptArgumentSuggestion[];
}

export interface ArgumentTypeaheadQuery {
  readonly command: ArgumentTypeaheadCommand;
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

function typeaheadCommand(command: string):
  | {
      readonly name: ArgumentTypeaheadCommand;
      readonly maxArguments: number;
      readonly loadingLabel: string;
    }
  | undefined {
  const spec = PROMPT_COMMANDS.find((candidate) => candidate.name === command);
  if (spec?.typeahead === undefined) return undefined;
  return { name: spec.name as ArgumentTypeaheadCommand, ...spec.typeahead };
}

export function argumentTypeaheadLoadingLabel(command: ArgumentTypeaheadCommand): string {
  return typeaheadCommand(command)?.loadingLabel ?? "suggestions";
}

/**
 * Parses the active token in an inline command drawer. The command grammar
 * deliberately uses literal spaces, matching slash-command dispatch.
 */
export function argumentTypeaheadQuery(text: string): ArgumentTypeaheadQuery | undefined {
  if (!text.startsWith("/")) return undefined;
  const commandEnd = text.indexOf(" ");
  if (commandEnd < 0) return undefined;
  const typeahead = typeaheadCommand(text.slice(1, commandEnd));
  if (typeahead === undefined) return undefined;

  const tokens: { value: string; start: number }[] = [];
  let cursor = commandEnd;
  while (cursor < text.length) {
    while (text[cursor] === " ") cursor += 1;
    if (cursor === text.length) break;
    const start = cursor;
    while (cursor < text.length && text[cursor] !== " ") cursor += 1;
    tokens.push({ value: text.slice(start, cursor), start });
  }
  const argumentCount = tokens.length + (text.endsWith(" ") ? 1 : 0);
  if (text.slice(commandEnd).includes("\n") || argumentCount > typeahead.maxArguments) {
    return undefined;
  }
  const active = tokens.at(-1);
  const completed = tokens.map((token) => token.value);
  if (!text.endsWith(" ") && active !== undefined) completed.pop();
  return {
    command: typeahead.name,
    argument: text.endsWith(" ") ? "" : (active?.value ?? ""),
    completed,
    argumentStart: text.endsWith(" ") ? text.length : (active?.start ?? text.length),
  };
}

function sanitizeSuggestion(suggestion: PromptArgumentSuggestion): PromptArgumentSuggestion {
  const sanitized: {
    value: string;
    label: string;
    hint?: string;
    next?: readonly PromptArgumentSuggestion[];
  } = {
    value: sanitizeForTerminal(suggestion.value),
    label: sanitizeForTerminal(suggestion.label),
  };
  if (suggestion.hint !== undefined) sanitized.hint = sanitizeForTerminal(suggestion.hint);
  if (suggestion.next !== undefined) sanitized.next = suggestion.next.map(sanitizeSuggestion);
  return sanitized;
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
