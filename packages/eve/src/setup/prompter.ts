import { isCancel, Prompt, settings, type State, TextPrompt } from "#compiled/@clack/core/index.js";
import {
  cornerFor,
  formatPromptCancellation,
  formatPromptHeader,
  formatPromptOpener,
  formatPromptOutro,
  formatPromptSubmission,
  formatRailLine,
  railFor,
  runSelectComponent,
  type ChannelSetupAwaitChoice,
  type PromptState,
} from "#setup/cli/index.js";
import { createRailLog, type RailSpinner } from "#setup/cli/index.js";
import pc from "#compiled/picocolors/index.js";

import {
  initialQuitGuardState,
  quitHintNote,
  reduceQuitGuard,
  type QuitGuardState,
} from "./quit-guard.js";
import { WizardCancelledError } from "./step.js";

export type PrompterValue = string | number | boolean;

export interface SelectOption<T extends PrompterValue> {
  value: T;
  label: string;
  keywords?: readonly string[];
  trailingAction?: boolean;
  hint?: string;
  focusHint?: string;
  description?: string;
  accent?: "warning";
  disabled?: boolean;
  disabledReason?: string;
  disabledReasonTone?: "warning";
  completed?: boolean;
  locked?: boolean;
  lockedReason?: string;
  featured?: boolean;
  checked?: boolean;
}

export interface SelectNotice {
  tone: "success" | "info" | "warning" | "error";
  text: string;
}

export interface SelectMetadata {
  label: string;
  value: string;
}

export class PlannerNavigationError extends Error {
  readonly direction: "back" | "forward";
  readonly values: readonly PrompterValue[];

  constructor(direction: "back" | "forward", values: readonly PrompterValue[]) {
    super(`Planner requested ${direction} navigation.`);
    this.name = "PlannerNavigationError";
    this.direction = direction;
    this.values = values;
  }
}

export interface PlannerNavigation {
  kind: "planner";
  activeStep: number;
  firstNavigableStep?: number;
  steps: readonly { label: string; count?: number; complete?: boolean }[];
}

export interface SelectCommonOptions<T extends PrompterValue> {
  message: string;
  description?: string;
  helpText?: string;
  metadata?: readonly SelectMetadata[];
  options: SelectOption<T>[];
  search?: boolean;
  placeholder?: string;
  required?: boolean;
  hintLayout?: "stacked" | "inline";
  notices?: readonly SelectNotice[];
  navigation?: PlannerNavigation;
}

export interface SearchAction<T extends PrompterValue> {
  label(query: string): string;
  value(query: string): T;
  load?(query: string): Promise<readonly SelectOption<T>[]>;
}

export interface SingleSelectOptions<T extends PrompterValue> extends SelectCommonOptions<T> {
  multiple?: false;
  initialValue?: T;
  searchAction?: SearchAction<T>;
}

export interface MultiSelectOptions<T extends PrompterValue> extends SelectCommonOptions<T> {
  multiple: true;
  initialValues?: T[];
}

export type EditableSelectResult<T extends PrompterValue> =
  | { kind: "selected"; value: T }
  | { kind: "edited"; value: T; text: string };

export interface EditableSelectOptions<T extends PrompterValue> extends SingleSelectOptions<T> {
  editable: {
    value: T;
    defaultValue: string;
    formatHint: (value: string) => string;
    validate?: (value: string) => string | undefined;
  };
}

export type NoteTone = "warning" | "success";

export interface AcknowledgeOptions {
  message: string;
  lines?: readonly string[];
}

export interface Prompter {
  text(opts: {
    message: string;
    placeholder?: string;
    defaultValue?: string;
    validate?: (value: string) => string | undefined;
    notices?: readonly SelectNotice[];
  }): Promise<string>;

  password(opts: {
    message: string;
    validate?: (value: string) => string | undefined;
  }): Promise<string>;

  select<T extends PrompterValue>(opts: SingleSelectOptions<T>): Promise<T>;
  select<T extends PrompterValue>(opts: MultiSelectOptions<T>): Promise<T[]>;
  selectEditable?<T extends PrompterValue>(
    opts: EditableSelectOptions<T>,
  ): Promise<EditableSelectResult<T>>;

  acknowledge?(opts: AcknowledgeOptions): Promise<void>;

  awaitChoice?: ChannelSetupAwaitChoice;

  note(message: string, title?: string, options?: { tone?: NoteTone }): void;

  intro(title: string, subtitle?: string): void;

  outro(message: string): void;

  replaceContent?(content?: {
    headline: string;
    facts: readonly { label: string; value: string }[];
  }): void;

  withInheritedStdio?<T>(task: () => Promise<T>): Promise<T>;

  withExclusiveTerminal?<T>(task: () => Promise<T>): Promise<T>;

  log: {
    message(text: string): void;
    info(text: string): void;
    success(text: string): void;
    warning(text: string): void;
    error(text: string): void;
    commandOutput(text: string): void;
    section?(title: string, lines: readonly string[]): void;
    spinner?(message: string): RailSpinner;
  };
}

const DEFAULT_INTRO_SUBTITLE = "Production-grade agent framework.";

function guardCancel<T>(value: T | symbol): T {
  if (isCancel(value)) {
    process.stdout.write(formatPromptCancellation("Setup cancelled.", pc));
    throw new WizardCancelledError();
  }
  return value as T;
}

let escapeCancelDisabled = false;

function disableEscapeCancel(): void {
  if (escapeCancelDisabled) return;
  settings.aliases.delete("escape");
  escapeCancelDisabled = true;
}

interface QuitGuard {
  note(): string | undefined;
}

function attachQuitGuard<T>(prompt: Prompt<T>): QuitGuard {
  let state: QuitGuardState = initialQuitGuardState;
  prompt.on("key", (_char, info) => {
    const { state: next, action } = reduceQuitGuard(
      state,
      info?.name === "escape" ? { type: "escape" } : { type: "other-key" },
    );
    state = next;
    if (action === "quit") {
      prompt.state = "cancel";
    }
  });
  return { note: () => quitHintNote(state, pc) };
}

function toPromptState(state: State): PromptState {
  return state;
}

function railForState(state: State): string {
  return railFor(toPromptState(state), pc);
}

function cornerForState(state: State): string {
  return cornerFor(toPromptState(state), pc);
}

function header(state: State, message: string, resolvedCount: number): string {
  return formatPromptHeader(toPromptState(state), message, {
    colors: pc,
    leadingRail: resolvedCount === 0 ? "white" : "green",
  });
}

const REDACTED_DISPLAY = "••••••••";

function textPrompt(
  resolvedCount: number,
  opts: {
    message: string;
    placeholder?: string;
    defaultValue?: string;
    mask?: boolean;
    validate?: (value: string) => string | undefined;
  },
): Promise<string | symbol | undefined> {
  let quitGuard: QuitGuard | undefined;
  const prompt = new TextPrompt({
    validate: opts.validate ? (value) => opts.validate?.(value ?? "") : undefined,
    placeholder: opts.placeholder,
    defaultValue: opts.defaultValue,
    initialValue: opts.defaultValue,
    render() {
      const head = header(this.state, opts.message, resolvedCount);
      const placeholderRendered = opts.placeholder
        ? pc.inverse(opts.placeholder[0]) + pc.dim(opts.placeholder.slice(1))
        : pc.inverse(pc.hidden("_"));
      const maskedBody = this.value ? "•".repeat(this.value.length) : placeholderRendered;
      let body = placeholderRendered;
      if (opts.mask) {
        body = maskedBody;
      } else if (this.value) {
        body = this.userInputWithCursor;
      }

      switch (this.state) {
        case "error":
          return `${head.trim()}\n${railForState(this.state)}  ${body}\n${cornerForState(this.state)}  ${pc.red(this.error)}\n`;
        case "submit": {
          let display = this.value || opts.placeholder || "";
          if (opts.mask) {
            display = this.value ? REDACTED_DISPLAY : (opts.placeholder ?? "");
          }
          return formatPromptSubmission(this.state, opts.message, display, {
            colors: pc,
            leadingRail: resolvedCount === 0 ? "white" : "green",
          });
        }
        case "cancel":
          return `${head}${railForState(this.state)}  ${pc.strikethrough(pc.dim(opts.mask && this.value ? REDACTED_DISPLAY : (this.value ?? "")))}${
            this.value?.trim() ? `\n${railForState(this.state)}` : ""
          }`;
        default:
          return `${head}${railForState(this.state)}  ${body}\n${cornerForState(this.state)}${cornerNote(quitGuard?.note())}\n`;
      }
    },
  });
  quitGuard = attachQuitGuard(prompt);
  return prompt.prompt();
}

function cornerNote(note: string | undefined): string {
  return note ? `  ${note}` : "";
}

export function createPrompter(): Prompter {
  disableEscapeCancel();
  let resolvedCount = 0;
  const log = createRailLog({ colors: pc, output: process.stdout });

  function printNotices(notices: readonly SelectNotice[] | undefined): void {
    for (const notice of notices ?? []) {
      if (notice.tone === "success") log.success(notice.text);
      else if (notice.tone === "warning") log.warning(notice.text);
      else if (notice.tone === "error") log.error(notice.text);
      else log.message(notice.text);
    }
  }

  return {
    async text(opts) {
      log.settle();
      printNotices(opts.notices);
      const result = guardCancel(await textPrompt(resolvedCount, opts));
      resolvedCount += 1;
      return result ?? "";
    },

    async password(opts) {
      log.settle();
      const result = guardCancel(
        await textPrompt(resolvedCount, {
          message: opts.message,
          mask: true,
          validate: opts.validate,
        }),
      );
      resolvedCount += 1;
      return result ?? "";
    },

    async select<T extends PrompterValue>(
      opts: SingleSelectOptions<T> | MultiSelectOptions<T>,
    ): Promise<T | T[]> {
      log.settle();
      printNotices(opts.notices);
      if (opts.description !== undefined) {
        process.stdout.write(formatRailLine(pc.dim(opts.description), pc, process.stdout));
      }
      for (const { label, value } of opts.metadata ?? []) {
        process.stdout.write(formatRailLine(`${pc.dim(`${label}:`)} ${value}`, pc, process.stdout));
      }
      const result = guardCancel(
        await runSelectComponent<T>({
          message: opts.message,
          helpText: opts.helpText,
          options: opts.options,
          multiple: opts.multiple === true,
          search: opts.search ?? false,
          searchAction: opts.multiple === true ? undefined : opts.searchAction,
          required: opts.required ?? false,
          placeholder: opts.placeholder,
          defaultValue: opts.multiple === true ? undefined : opts.initialValue,
          initialValues: opts.multiple === true ? opts.initialValues : undefined,
          leadingRail: resolvedCount === 0 ? "white" : "green",
          attachGuard: (prompt) => attachQuitGuard(prompt),
        }),
      );
      resolvedCount += 1;
      return result;
    },

    async acknowledge(opts) {
      log.settle();
      process.stdout.write(formatRailLine(pc.bold(opts.message), pc, process.stdout));
      for (const line of opts.lines ?? []) {
        process.stdout.write(formatRailLine(pc.dim(line), pc, process.stdout));
      }
    },

    note(message, title, options) {
      log.settle();
      const paint = options?.tone === "success" ? pc.green : pc.red;
      if (title) process.stdout.write(formatRailLine(paint(pc.bold(title)), pc, process.stdout));
      process.stdout.write(formatRailLine(paint(message), pc, process.stdout));
    },

    intro(title, subtitle = DEFAULT_INTRO_SUBTITLE) {
      log.settle();
      process.stdout.write(formatPromptOpener(title, subtitle, pc));
    },

    outro(message) {
      log.settle();
      process.stdout.write(formatPromptOutro(message, pc));
    },

    log,
  };
}
