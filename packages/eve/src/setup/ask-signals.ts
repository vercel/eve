import type { EditableSelectQuestion } from "./ask-editable.js";
import type { MultiSelectQuestion, Question } from "./ask.js";

/** Thrown when a skippable question is skipped, so the box can branch on it. */
export class SkippedSignal extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`Skipped: ${key}`);
    this.name = "SkippedSignal";
    this.key = key;
  }
}

/** Any question the channel can carry, for signals that quote one. */
export type AnyQuestion =
  | Question<unknown>
  | EditableSelectQuestion<unknown>
  | MultiSelectQuestion<unknown>;

/**
 * Headless refusal that keeps the whole question: an agent driver can relay
 * exactly what is missing (key, message, options) instead of a bare string.
 */
export class InteractionRequired extends Error {
  readonly question: AnyQuestion;
  constructor(question: AnyQuestion) {
    super(`Interaction required for "${question.key}": ${question.message}`);
    this.name = "InteractionRequired";
    this.question = question;
  }
}

/** Thrown when a pre-supplied answer fails the question's own validation. */
export class InvalidAnswerError extends Error {
  readonly question: AnyQuestion;
  constructor(question: AnyQuestion, message: string) {
    super(message);
    this.name = "InvalidAnswerError";
    this.question = question;
  }

  get key(): string {
    return this.question.key;
  }
}
