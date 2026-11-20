import { isCancel, Prompt, type State } from "#compiled/@clack/core/index.js";
import pc from "#compiled/picocolors/index.js";

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
  searchActionQuery,
  selectValueAtCursor,
  submitRowIndex,
  type SearchActionOption,
  type SelectEvent,
  type SelectState,
} from "./select-state.js";

export interface SelectGuard {
  note(): string | undefined;
}

function toPromptState(state: State): PromptState {
  return state === "validating" ? "active" : state;
}

export class SelectComponent extends Prompt<string | string[]> {
  readonly options: PromptOption<string>[];
  readonly multiple: boolean;
  readonly search: boolean;
  readonly searchAction: SearchActionOption | undefined;
  readonly required: boolean;
  filter = "";
  optionCursor = 0;
  selectedSet = new Set<string>();

  constructor(input: {
    options: PromptOption<string>[];
    multiple: boolean;
    search: boolean;
    searchAction?: SearchActionOption;
    required: boolean;
    initial: SelectState;
    render: (this: Omit<SelectComponent, "prompt">) => string | undefined;
  }) {
    super({ render: input.render, validate: () => this.submitError() }, false);
    this.options = input.options;
    this.multiple = input.multiple;
    this.search = input.search;
    this.searchAction = input.searchAction;
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
    return filterOptions(this.options, this.filter, this.searchAction);
  }

  onSubmitRow(): boolean {
    return this.multiple && this.optionCursor === submitRowIndex(this.visibleOptions());
  }

  submitLabel(): "Submit" | "Skip" {
    if (this.required) return "Submit";
    const locked = new Set(
      this.options.filter((option) => option.locked).map((option) => option.value),
    );
    const picked = [...this.selectedSet].some((value) => !locked.has(value));
    return picked ? "Submit" : "Skip";
  }

  protected override _shouldSubmit(): boolean {
    if (!this.multiple) {
      const option = this.visibleOptions()[this.optionCursor];
      return option?.completed !== true;
    }
    if (this.onSubmitRow()) return true;
    this.apply({ type: "toggle" });
    return false;
  }

  selectedValues(): string[] {
    if (this.multiple) return orderedSelection(this.options, this.selectedSet);
    const value = selectValueAtCursor(this.visibleOptions(), this.optionCursor);
    return value === undefined ? [] : [value];
  }

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
    const query = searchActionQuery(value);
    if (query !== undefined && this.searchAction !== undefined) {
      return this.searchAction.label(query);
    }
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
      { options: this.options, searchAction: this.searchAction, submitRow: this.multiple },
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

function renderSelectComponent(
  self: SelectComponent,
  opts: { message: string; placeholder?: string; helpText?: string },
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
      helpText: opts.helpText,
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
      helpText: opts.helpText,
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
    helpText: opts.helpText,
    options: self.options,
    state,
  });
}

export async function runSelectComponent<T extends PromptValue>(input: {
  message: string;
  helpText?: string;
  options: readonly PromptOption<T>[];
  multiple: boolean;
  search: boolean;
  searchAction?: { label(query: string): string; value(query: string): T };
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
    searchAction:
      input.searchAction === undefined ? undefined : { label: input.searchAction.label },
    required: input.required,
    initial,
    render() {
      if (!promptRef) return "";
      return renderSelectComponent(
        promptRef,
        { message: input.message, placeholder: input.placeholder, helpText: input.helpText },
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
  if (Array.isArray(result)) return result.map((key) => codec.decode(key));
  const query = searchActionQuery(result);
  if (query !== undefined && input.searchAction !== undefined) {
    return input.searchAction.value(query);
  }
  return codec.decode(result);
}
