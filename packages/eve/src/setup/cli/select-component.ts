import { isCancel, Prompt, type State } from "@clack/core";
import pc from "picocolors";

import {
  renderMultiselectPrompt,
  renderSearchableSelect,
  renderSelectPrompt,
  type PromptOption,
  type PromptState,
  type PromptValue,
} from "./prompt-ui.js";
import { createSelectOptionCodec } from "./select-option-codec.js";
import {
  filterOptions,
  initialSelectState,
  orderedSelection,
  reduceSelect,
  selectValueAtCursor,
  submitRowIndex,
  type SelectEvent,
  type SelectState,
} from "./select-state.js";

/**
 * A prompt's live status note (e.g. a two-stage quit guard), read on each
 * render. Returns `undefined` when there is nothing to show. Wired in by
 * {@link runSelectComponent} via its `attachGuard` hook.
 */
export interface SelectGuard {
  note(): string | undefined;
}

function toPromptState(state: State): PromptState {
  return state;
}

/**
 * Custom `@clack/core` `Prompt` backing every select picker. It adapts key
 * events to {@link reduceSelect} transitions and tracks the resolved value: the
 * highlighted option for single-select, the marked set for multi-select.
 * Filtering, multi-selection, and the cursor arrow are all driven by the
 * `search` and `multiple` flags, so one component covers every picker.
 */
export class SelectComponent extends Prompt<string | string[]> {
  readonly options: PromptOption<string>[];
  readonly multiple: boolean;
  readonly search: boolean;
  readonly required: boolean;
  filter = "";
  optionCursor = 0;
  selectedSet = new Set<string>();

  constructor(input: {
    options: PromptOption<string>[];
    multiple: boolean;
    search: boolean;
    required: boolean;
    initial: SelectState;
    render: (this: Omit<SelectComponent, "prompt">) => string | undefined;
  }) {
    super({ render: input.render, validate: () => this.submitError() }, false);
    this.options = input.options;
    this.multiple = input.multiple;
    this.search = input.search;
    this.required = input.required;
    this.filter = input.initial.filter;
    this.optionCursor = input.initial.cursor;
    this.selectedSet = input.initial.selected;
    this.refreshValue();

    this.on("key", (key, info) => {
      if (this.multiple && info?.name === "space") {
        this.apply({ type: "toggle" });
        return;
      }
      if (!this.search) return;
      if (info?.name === "backspace" || key === "\x7f" || key === "\b") {
        this.apply({ type: "backspace" });
        return;
      }
      // Space is a filter character too — only a multi-select reserves it for
      // toggling (handled above, before this point).
      if (key !== undefined && key.length === 1 && key >= " " && key !== "\x7f") {
        this.apply({ type: "char", char: key });
      }
    });

    this.on("cursor", (direction) => {
      if (direction === "up" || direction === "left") this.apply({ type: "up" });
      else if (direction === "down" || direction === "right") this.apply({ type: "down" });
    });
  }

  visibleOptions(): PromptOption<string>[] {
    return filterOptions(this.options, this.filter);
  }

  /** True when the multi-select cursor sits on the trailing Submit row. */
  onSubmitRow(): boolean {
    return this.multiple && this.optionCursor === submitRowIndex(this.visibleOptions());
  }

  /**
   * Submit-row label: "Skip" while an optional checklist has nothing picked,
   * "Submit" as soon as one row is marked. Locked rows are mandatory rather
   * than chosen, so they do not count as a pick; a required checklist always
   * says "Submit" since an empty confirm cannot resolve it.
   */
  submitLabel(): "Submit" | "Skip" {
    if (this.required) return "Submit";
    const locked = new Set(
      this.options.filter((option) => option.locked).map((option) => option.value),
    );
    const picked = [...this.selectedSet].some((value) => !locked.has(value));
    return picked ? "Submit" : "Skip";
  }

  /**
   * Enter resolves an actionable single-select row; completed rows are
   * focus-only. A multi-select resolves only from its Submit row — on any
   * option row it toggles instead, so enter can never accidentally skip the
   * checklist.
   */
  protected override _shouldSubmit(): boolean {
    if (!this.multiple) {
      const option = this.visibleOptions()[this.optionCursor];
      return option?.completed !== true;
    }
    if (this.onSubmitRow()) return true;
    this.apply({ type: "toggle" });
    return false;
  }

  /** Values that should render as chosen: the marked set, or the cursor for single. */
  selectedValues(): string[] {
    if (this.multiple) return orderedSelection(this.options, this.selectedSet);
    const value = selectValueAtCursor(this.visibleOptions(), this.optionCursor);
    return value === undefined ? [] : [value];
  }

  /** The folded answer shown once the prompt resolves. */
  submitDisplay(): string {
    if (this.multiple) {
      const labels = this.options
        .filter((option) => this.selectedSet.has(option.value))
        .map((option) => option.label);
      return labels.length > 0 ? labels.join(", ") : pc.dim("(none selected)");
    }
    const value = selectValueAtCursor(this.visibleOptions(), this.optionCursor);
    return value === undefined ? "" : this.labelForValue(value);
  }

  labelForValue(value: string): string {
    return this.options.find((option) => option.value === value)?.label ?? value;
  }

  submitError(): string | undefined {
    if (this.multiple) {
      return this.required && this.selectedSet.size === 0
        ? "Select at least one option, then press enter."
        : undefined;
    }
    return selectValueAtCursor(this.visibleOptions(), this.optionCursor) === undefined
      ? "Type to match an option, then press enter."
      : undefined;
  }

  private apply(event: SelectEvent): void {
    const next = reduceSelect(
      { filter: this.filter, cursor: this.optionCursor, selected: this.selectedSet },
      event,
      { options: this.options, submitRow: this.multiple },
    );
    this.filter = next.filter;
    this.optionCursor = next.cursor;
    this.selectedSet = next.selected;
    this.refreshValue();
  }

  private refreshValue(): void {
    this.value = this.multiple
      ? orderedSelection(this.options, this.selectedSet)
      : selectValueAtCursor(this.visibleOptions(), this.optionCursor);
  }
}

/** Renders the active component by dispatching to the renderer for its mode. */
function renderSelectComponent(
  self: SelectComponent,
  opts: { message: string; placeholder?: string },
  leadingRail: "white" | "green",
  footerNote: string | undefined,
): string {
  const state = toPromptState(self.state);

  if (self.search) {
    return renderSearchableSelect({
      colors: pc,
      state,
      leadingRail,
      message: opts.message,
      multiple: self.multiple,
      filter: self.filter,
      placeholder: opts.placeholder,
      options: self.visibleOptions(),
      cursor: self.optionCursor,
      selectedValues: self.selectedValues(),
      submitDisplay: self.submitDisplay(),
      footerNote,
      error: self.error,
      submitLabel: self.submitLabel(),
    });
  }

  if (self.multiple) {
    return renderMultiselectPrompt({
      colors: pc,
      cursor: self.optionCursor,
      error: self.error,
      footerNote,
      leadingRail,
      message: opts.message,
      options: self.options,
      selectedValues: self.selectedValues(),
      state,
      submitLabel: self.submitLabel(),
    });
  }

  return renderSelectPrompt({
    colors: pc,
    cursor: self.optionCursor,
    footerNote,
    leadingRail,
    message: opts.message,
    options: self.options,
    state,
  });
}

/**
 * Runs one select picker and resolves to the chosen value(s), or a clack cancel
 * symbol when the prompt is cancelled (the caller maps that to its own error).
 * Single-select returns the highlighted value, multi-select the marked set.
 *
 * Option values round-trip through opaque string keys so values of different
 * primitive types cannot collide. `attachGuard` wires
 * extra key handling (e.g. a two-stage quit guard) and supplies the live footer
 * note; `leadingRail` colors the leader rail white for the first prompt in a
 * sequence and green thereafter.
 */
export async function runSelectComponent<T extends PromptValue>(input: {
  message: string;
  options: readonly PromptOption<T>[];
  multiple: boolean;
  search: boolean;
  required: boolean;
  placeholder?: string;
  defaultValue?: T;
  initialValues?: readonly T[];
  leadingRail: "white" | "green";
  attachGuard?: (prompt: SelectComponent) => SelectGuard;
}): Promise<T | T[] | symbol> {
  const codec = createSelectOptionCodec(input.options);

  const initial = initialSelectState({
    options: codec.options,
    defaultValue: input.defaultValue === undefined ? undefined : codec.encode(input.defaultValue),
    initialValues: input.initialValues?.map((value) => codec.encode(value)),
    submitRow: input.multiple,
  });

  let promptRef: SelectComponent | undefined;
  let guard: SelectGuard | undefined;

  const prompt = new SelectComponent({
    options: codec.options,
    multiple: input.multiple,
    search: input.search,
    required: input.required,
    initial,
    render() {
      if (!promptRef) return "";
      return renderSelectComponent(
        promptRef,
        { message: input.message, placeholder: input.placeholder },
        input.leadingRail,
        guard?.note(),
      );
    },
  });

  promptRef = prompt;
  guard = input.attachGuard?.(prompt);

  const result = await prompt.prompt();
  if (isCancel(result)) return result;
  if (result === undefined) {
    throw new Error("Select prompt returned no value.");
  }
  return Array.isArray(result) ? result.map((key) => codec.decode(key)) : codec.decode(result);
}
