import type { AnyQuestion } from "./ask.js";
import { requiredOptionId } from "./question-options.js";

export interface SetupWireOption {
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  disabledReason?: string;
  locked?: boolean;
  lockedReason?: string;
}

type SharedWireQuestion = { key: string; message: string; required: boolean };
export type SetupWireQuestion =
  | (SharedWireQuestion & { kind: "confirm"; recommended?: boolean })
  | (SharedWireQuestion & { kind: "text"; placeholder?: string; sensitive?: false })
  | (SharedWireQuestion & { kind: "environment"; variable: string; sensitive: true })
  | (SharedWireQuestion & {
      kind: "select";
      recommended?: string;
      options: readonly SetupWireOption[];
    })
  | (SharedWireQuestion & {
      kind: "multi-select";
      recommended?: readonly string[];
      options: readonly SetupWireOption[];
    });

function wireOptions(question: {
  options: readonly {
    id: string;
    label: string;
    hint?: string;
    disabled?: boolean;
    disabledReason?: string;
    locked?: boolean;
    lockedReason?: string;
  }[];
}): SetupWireOption[] {
  return question.options.map((option) => {
    const wire: SetupWireOption = { id: option.id, label: option.label };
    if (option.hint !== undefined) wire.hint = option.hint;
    if (option.disabled !== undefined) wire.disabled = option.disabled;
    if (option.disabledReason !== undefined) wire.disabledReason = option.disabledReason;
    if (option.locked !== undefined) wire.locked = option.locked;
    if (option.lockedReason !== undefined) wire.lockedReason = option.lockedReason;
    return wire;
  });
}

function sharedQuestion(question: AnyQuestion): SharedWireQuestion {
  return { key: question.key, message: question.message, required: question.required === true };
}

/** Removes runtime values and validators from one internal setup question. */
export function setupQuestionToWire(question: AnyQuestion): SetupWireQuestion {
  const shared = sharedQuestion(question);
  if (!("kind" in question)) {
    const many = question;
    const wire: Extract<SetupWireQuestion, { kind: "multi-select" }> = {
      ...shared,
      kind: "multi-select",
      options: wireOptions(many),
    };
    if (many.recommended !== undefined) {
      wire.recommended = many.recommended.map((value) =>
        requiredOptionId(many, value, "recommendation"),
      );
    }
    return wire;
  }
  const single = question;
  if (single.kind === "confirm") {
    const wire: Extract<SetupWireQuestion, { kind: "confirm" }> = { ...shared, kind: "confirm" };
    if (single.recommended !== undefined) wire.recommended = single.recommended as boolean;
    return wire;
  }
  if (single.kind === "text") {
    if (single.sensitive === true)
      return { ...shared, kind: "environment", variable: single.environment, sensitive: true };
    const wire: Extract<SetupWireQuestion, { kind: "text" }> = {
      ...shared,
      kind: "text",
      sensitive: false,
    };
    if (single.placeholder !== undefined) wire.placeholder = single.placeholder;
    return wire;
  }
  const wire: Extract<SetupWireQuestion, { kind: "select" }> = {
    ...shared,
    kind: "select",
    options: wireOptions(single),
  };
  if (single.recommended !== undefined) {
    wire.recommended = requiredOptionId(single, single.recommended, "recommendation");
  }
  return wire;
}
