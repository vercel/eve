import type { Prompter } from "./prompter.js";
import { optionById, requiredOptionId } from "./question-options.js";
import type { SelectOption } from "./ask.js";

export interface EditableSelectQuestion<T> {
  key: string;
  message: string;
  options: readonly SelectOption<T>[];
  recommended?: T;
  required?: boolean;
  editable: {
    key: string;
    value: T;
    label: string;
    recommended: string;
    validate?: (raw: string) => string | null;
  };
}

export interface EditableSelectAnswer<T> {
  value: T;
  text?: string;
}

function selectedValue<T>(question: EditableSelectQuestion<T>, id: unknown): T {
  const match = optionById(question, id);
  if (match !== undefined) return match.value;
  const ids = question.options.map((option) => option.id).join(", ");
  throw new Error(`Invalid answer for "${question.key}": ${String(id)}. Expected one of: ${ids}.`);
}

/** Renders the specialized one-row editable select through a terminal prompter. */
export async function renderEditableQuestion<T>(
  prompter: Prompter,
  question: EditableSelectQuestion<T>,
): Promise<EditableSelectAnswer<T>> {
  const editableOptionId = requiredOptionId(
    question,
    question.editable.value,
    "configured editable value",
  );
  const options = question.options.map((option) => ({
    value: option.id,
    label: option.label,
    hint: option.hint,
    featured: option.featured,
  }));
  const initialValue =
    question.recommended === undefined
      ? undefined
      : requiredOptionId(question, question.recommended, "recommendation");
  if (prompter.selectEditable !== undefined) {
    const result = await prompter.selectEditable({
      message: question.message,
      options,
      initialValue,
      editable: {
        value: editableOptionId,
        defaultValue: question.editable.recommended,
        formatHint: (value) => `${question.editable.label}: ${value}`,
        validate: (value) => question.editable.validate?.(value) ?? undefined,
      },
    });
    const value = selectedValue(question, result.value);
    return value === question.editable.value
      ? {
          value,
          text:
            result.kind === "edited" ? result.text.trim() : question.editable.recommended.trim(),
        }
      : { value };
  }
  const value = selectedValue(
    question,
    await prompter.select({ message: question.message, options, initialValue }),
  );
  if (value !== question.editable.value) return { value };
  const text = await prompter.text({
    message: question.editable.label,
    defaultValue: question.editable.recommended,
    validate: (raw) => question.editable.validate?.(raw) ?? undefined,
  });
  return { value, text: text.trim() };
}
