import { SetupPrerequisiteRequired } from "./integrations/shared/prerequisite.js";
import {
  renderEditableQuestion,
  type EditableSelectAnswer,
  type EditableSelectQuestion,
} from "./ask-editable.js";
import {
  InteractionRequired,
  InvalidAnswerError,
  SkippedSignal,
  type AnyQuestion,
} from "./ask-signals.js";
export type { EditableSelectAnswer, EditableSelectQuestion } from "./ask-editable.js";
export {
  InteractionRequired,
  InvalidAnswerError,
  SkippedSignal,
  type AnyQuestion,
} from "./ask-signals.js";
import type { Prompter } from "./prompter.js";
import { optionById, optionByValue, requiredOptionId } from "./question-options.js";

export interface SelectOption<T> {
  id: string;
  label: string;
  value: T;
  hint?: string;
  featured?: boolean;
}

export interface MultiSelectOption<T> extends SelectOption<T> {
  disabled?: boolean;
  disabledReason?: string;
  locked?: boolean;
  lockedReason?: string;
}

export type Question<T> = {
  key: string;
  message: string;
  detected?: T;
  recommended?: T;
  required?: boolean;
  internal?: boolean;
} & (
  | {
      kind: "select";
      options: readonly SelectOption<T>[];
      search?: boolean;
      placeholder?: string;
      hintLayout?: "stacked" | "inline";
    }
  | { kind: "confirm" }
  | {
      kind: "text";
      validate?: (raw: string) => string | null;
      sensitive?: false;
      placeholder?: string;
    }
  | {
      kind: "text";
      validate?: (raw: string) => string | null;
      sensitive: true;
      environment: string;
      placeholder?: string;
    }
);

export interface MultiSelectQuestion<T> {
  key: string;
  message: string;
  options: readonly MultiSelectOption<T>[];
  detected?: readonly T[];
  recommended?: readonly T[];
  required?: boolean;
  internal?: boolean;
  requireSelection?: boolean;
  search?: boolean;
  placeholder?: string;
}

export const select = <T>(
  q: Omit<Extract<Question<T>, { kind: "select" }>, "kind">,
): Question<T> => ({
  ...q,
  kind: "select",
});

export const confirm = (q: {
  key: string;
  message: string;
  detected?: boolean;
  recommended?: boolean;
  required?: boolean;
  internal?: boolean;
}): Question<boolean> => ({
  ...q,
  kind: "confirm",
});

interface TextQuestionInput {
  key: string;
  message: string;
  detected?: string;
  recommended?: string;
  required?: boolean;
  validate?: (raw: string) => string | null;
  placeholder?: string;
}

export function text(
  q: TextQuestionInput & { sensitive: true; environment: string },
): Question<string>;
export function text(
  q: TextQuestionInput & { sensitive?: false; environment?: never },
): Question<string>;
export function text(
  q: TextQuestionInput &
    ({ sensitive: true; environment: string } | { sensitive?: false; environment?: never }),
): Question<string> {
  return { ...q, kind: "text" };
}

export interface Asker {
  ask<T>(question: Question<T>): Promise<T>;
  askEditable<T>(question: EditableSelectQuestion<T>): Promise<EditableSelectAnswer<T>>;
  askMany<T>(question: MultiSelectQuestion<T>): Promise<T[]>;
}

type AskerDecorator = (inner: Asker) => Asker;

export type ResolutionSource = "answer" | "detected" | "assumed" | "asked" | "skipped";

export interface Resolution {
  key: string;
  value: unknown;
  source: ResolutionSource;
}

interface AskerEvents {
  onResolved?: (resolution: Resolution) => void;
}

function announce<T>(
  events: AskerEvents | undefined,
  key: string,
  value: T,
  source: ResolutionSource,
): T {
  events?.onResolved?.({ key, value, source });
  return value;
}

function coerceAnswer<T>(question: Question<T>, raw: unknown): T {
  if (question.kind === "select") {
    const id = String(raw);
    const match = optionById(question, id);
    if (!match) {
      const ids = question.options.map((option) => option.id).join(", ");
      throw new InvalidAnswerError(
        question,
        `Invalid answer for "${question.key}": ${id}. Expected one of: ${ids}.`,
      );
    }
    return match.value;
  }
  if (question.kind === "confirm") {
    const value =
      typeof raw === "boolean" ? raw : raw === "true" ? true : raw === "false" ? false : null;
    if (value === null) {
      throw new InvalidAnswerError(
        question,
        `Invalid answer for "${question.key}": expected a boolean.`,
      );
    }
    return value as T;
  }
  const value = String(raw);
  const problem = question.validate?.(value);
  if (problem) throw new InvalidAnswerError(question, problem);
  return value as T;
}

function coerceManyAnswer<T>(question: MultiSelectQuestion<T>, raw: unknown): T[] {
  if (!Array.isArray(raw)) {
    throw new InvalidAnswerError(
      question,
      `Invalid answer for "${question.key}": expected an array of option ids.`,
    );
  }
  const values: T[] = [];
  for (const item of raw) {
    const id = String(item);
    const match = optionById(question, id);
    if (!match) {
      const ids = question.options.map((option) => option.id).join(", ");
      throw new InvalidAnswerError(
        question,
        `Invalid answer for "${question.key}": ${id}. Expected one of: ${ids}.`,
      );
    }
    if (match.disabled) {
      const reason = match.disabledReason === undefined ? "" : ` (${match.disabledReason})`;
      throw new InvalidAnswerError(
        question,
        `Invalid answer for "${question.key}": ${id} is unavailable${reason}.`,
      );
    }
    if (!values.includes(match.value)) values.push(match.value);
  }
  for (const option of question.options) {
    if (option.locked === true && !values.includes(option.value)) values.push(option.value);
  }
  return values;
}

async function renderQuestion<T>(prompter: Prompter, question: Question<T>): Promise<T> {
  if (question.kind === "select") {
    const preselected = question.detected ?? question.recommended;
    const chosen = await prompter.select<string>({
      message: question.message,
      options: question.options.map((option) => ({
        value: option.id,
        label: option.label,
        hint: option.hint,
        featured: option.featured,
      })),
      initialValue:
        preselected === undefined
          ? undefined
          : requiredOptionId(
              question,
              preselected,
              question.detected !== undefined ? "detected value" : "recommendation",
            ),
      search: question.search,
      placeholder: question.placeholder,
      hintLayout: question.hintLayout,
    });
    return coerceAnswer(question, chosen);
  }
  if (question.kind === "confirm") {
    const fallback = question.detected ?? question.recommended;
    const chosen = await prompter.select<"yes" | "no">({
      message: question.message,
      options: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
      initialValue: fallback === undefined ? undefined : fallback ? "yes" : "no",
    });
    return coerceAnswer(question, chosen === "yes");
  }
  const validate = question.validate;
  const promptValidate =
    validate === undefined ? undefined : (value: string) => validate(value) ?? undefined;
  const prefilled = question.detected ?? question.recommended;
  const raw = question.sensitive
    ? await prompter.password({ message: question.message, validate: promptValidate })
    : await prompter.text({
        message: question.message,
        placeholder: question.placeholder,
        defaultValue: prefilled === undefined ? undefined : String(prefilled),
        validate: promptValidate,
      });
  return coerceAnswer(question, raw);
}

async function renderManyQuestion<T>(
  prompter: Prompter,
  question: MultiSelectQuestion<T>,
): Promise<T[]> {
  const premarked = question.detected ?? question.recommended;
  const chosen = await prompter.select<string>({
    multiple: true,
    message: question.message,
    options: question.options.map((option) => ({
      value: option.id,
      label: option.label,
      hint: option.hint,
      featured: option.featured,
      disabled: option.disabled,
      disabledReason: option.disabledReason,
      locked: option.locked,
      lockedReason: option.lockedReason,
    })),
    initialValues:
      premarked === undefined
        ? undefined
        : premarked.map((value) =>
            requiredOptionId(
              question,
              value,
              question.detected !== undefined ? "detected value" : "recommendation",
            ),
          ),
    required: question.requireSelection,
    search: question.search,
    placeholder: question.placeholder,
  });
  return chosen.map((id) => {
    const match = optionById(question, id);
    if (!match) {
      throw new InvalidAnswerError(
        question,
        `Invalid answer for "${question.key}": ${id} is not an option id.`,
      );
    }
    return match.value;
  });
}

export function interactiveAsker(prompter: Prompter, events?: AskerEvents): Asker {
  return {
    async ask<T>(question: Question<T>): Promise<T> {
      const value = await renderQuestion(prompter, question);
      if (question.internal) return value;
      return announce(events, question.key, value, "asked");
    },
    async askEditable<T>(question: EditableSelectQuestion<T>): Promise<EditableSelectAnswer<T>> {
      const result = await renderEditableQuestion(prompter, question);
      announce(events, question.key, result.value, "asked");
      if (result.text !== undefined) announce(events, question.editable.key, result.text, "asked");
      return result;
    },
    async askMany<T>(question: MultiSelectQuestion<T>): Promise<T[]> {
      const value = await renderManyQuestion(prompter, question);
      if (question.internal) return value;
      return announce(events, question.key, value, "asked");
    },
  };
}

export function headlessAsker(events?: AskerEvents): Asker {
  function refuse(question: AnyQuestion): never {
    if (question.required) throw new InteractionRequired(question);
    announce(events, question.key, undefined, "skipped");
    throw new SkippedSignal(question.key);
  }
  return {
    async ask<T>(question: Question<T>): Promise<T> {
      return refuse(question);
    },
    async askEditable<T>(question: EditableSelectQuestion<T>): Promise<EditableSelectAnswer<T>> {
      return refuse(question);
    },
    async askMany<T>(question: MultiSelectQuestion<T>): Promise<T[]> {
      return refuse(question);
    },
  };
}

export function withAnswers(
  answers: Record<string, unknown>,
  events?: AskerEvents,
): AskerDecorator {
  return (inner) => ({
    async ask<T>(question: Question<T>): Promise<T> {
      if (question.key in answers) {
        const value = coerceAnswer(question, answers[question.key]);
        return announce(events, question.key, value, "answer");
      }
      if (question.kind === "text" && question.sensitive === true) {
        const environmentValue = process.env[question.environment];
        if (environmentValue !== undefined) return coerceAnswer(question, environmentValue);
        try {
          return await inner.ask(question);
        } catch (error) {
          if (!(error instanceof InteractionRequired)) throw error;
          throw new SetupPrerequisiteRequired({
            kind: "environment",
            code: question.key,
            message: `Set ${question.environment}, then retry setup.`,
            variable: question.environment,
            sensitive: true,
          });
        }
      }
      return inner.ask(question);
    },
    async askEditable<T>(question: EditableSelectQuestion<T>): Promise<EditableSelectAnswer<T>> {
      if (!(question.key in answers)) return inner.askEditable(question);
      const selection = coerceAnswer(
        select({ key: question.key, message: question.message, options: question.options }),
        answers[question.key],
      );
      announce(events, question.key, selection, "answer");
      if (selection !== question.editable.value) return { value: selection };
      if (!(question.editable.key in answers)) {
        const value = await inner.ask(
          text({
            key: question.editable.key,
            message: optionByValue(question, selection)?.label ?? question.message,
            recommended: question.editable.recommended,
            required: question.required,
            validate: question.editable.validate,
          }),
        );
        return { value: selection, text: value.trim() };
      }
      const raw = String(answers[question.editable.key]);
      const problem = question.editable.validate?.(raw);
      if (problem) {
        throw new InvalidAnswerError(
          text({
            key: question.editable.key,
            message: question.editable.label,
            required: question.required,
          }),
          problem,
        );
      }
      const value = raw.trim();
      announce(events, question.editable.key, value, "answer");
      return { value: selection, text: value };
    },
    async askMany<T>(question: MultiSelectQuestion<T>): Promise<T[]> {
      if (question.key in answers) {
        const value = coerceManyAnswer(question, answers[question.key]);
        return announce(events, question.key, value, "answer");
      }
      return inner.askMany(question);
    },
  });
}

export function withRequired(keys: readonly string[]): AskerDecorator {
  return (inner) => ({
    async ask<T>(question: Question<T>): Promise<T> {
      if (!question.required && keys.includes(question.key)) {
        return inner.ask({ ...question, required: true });
      }
      return inner.ask(question);
    },
    async askEditable<T>(question: EditableSelectQuestion<T>): Promise<EditableSelectAnswer<T>> {
      return inner.askEditable(
        !question.required && keys.includes(question.key)
          ? { ...question, required: true }
          : question,
      );
    },
    async askMany<T>(question: MultiSelectQuestion<T>): Promise<T[]> {
      if (!question.required && keys.includes(question.key)) {
        return inner.askMany({ ...question, required: true });
      }
      return inner.askMany(question);
    },
  });
}

type AnswerPolicy = "confirm-detected" | "assume";

export function withPolicy(policy: AnswerPolicy, events?: AskerEvents): AskerDecorator {
  return (inner) => ({
    async ask<T>(question: Question<T>): Promise<T> {
      if (policy === "assume") {
        if (question.detected !== undefined) {
          if (question.kind === "select") {
            requiredOptionId(question, question.detected, "detected value");
          }
          return announce(events, question.key, question.detected, "detected");
        }
        if (question.recommended !== undefined) {
          if (question.kind === "select") {
            requiredOptionId(question, question.recommended, "recommendation");
          }
          return announce(events, question.key, question.recommended, "assumed");
        }
        if (!question.required) {
          announce(events, question.key, undefined, "skipped");
          throw new SkippedSignal(question.key);
        }
        return inner.ask(question);
      }
      if (question.detected !== undefined) {
        const accepted = await inner.ask(
          confirm({
            key: question.key,
            message: `Use the detected value for "${question.key}"?`,
            internal: true,
          }),
        );
        if (accepted) return announce(events, question.key, question.detected, "detected");
      }
      return inner.ask(question);
    },
    async askEditable<T>(question: EditableSelectQuestion<T>): Promise<EditableSelectAnswer<T>> {
      if (policy !== "assume" || question.recommended === undefined) {
        return inner.askEditable(question);
      }
      requiredOptionId(question, question.editable.value, "configured editable value");
      requiredOptionId(question, question.recommended, "recommendation");
      const result: EditableSelectAnswer<T> =
        question.recommended === question.editable.value
          ? { value: question.recommended, text: question.editable.recommended }
          : { value: question.recommended };
      announce(events, question.key, result.value, "assumed");
      if (result.text !== undefined) {
        announce(events, question.editable.key, result.text, "assumed");
      }
      return result;
    },
    async askMany<T>(question: MultiSelectQuestion<T>): Promise<T[]> {
      if (policy === "assume") {
        if (question.detected !== undefined) {
          for (const value of question.detected) {
            requiredOptionId(question, value, "detected value");
          }
          return announce(events, question.key, [...question.detected], "detected");
        }
        if (question.recommended !== undefined) {
          for (const value of question.recommended) {
            requiredOptionId(question, value, "recommendation");
          }
          return announce(events, question.key, [...question.recommended], "assumed");
        }
        if (!question.required) {
          announce(events, question.key, undefined, "skipped");
          throw new SkippedSignal(question.key);
        }
        return inner.askMany(question);
      }
      if (question.detected !== undefined) {
        const accepted = await inner.ask(
          confirm({
            key: question.key,
            message: `Use the detected value for "${question.key}"?`,
            internal: true,
          }),
        );
        if (accepted) return announce(events, question.key, [...question.detected], "detected");
      }
      return inner.askMany(question);
    },
  });
}
