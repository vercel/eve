import type { EditableSelectQuestion } from "./ask-editable.js";
import type { MultiSelectQuestion, Question } from "./ask.js";

export class SkippedSignal extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`Skipped: ${key}`);
    this.name = "SkippedSignal";
    this.key = key;
  }
}

export type AnyQuestion =
  | Question<unknown>
  | EditableSelectQuestion<unknown>
  | MultiSelectQuestion<unknown>;

export class InteractionRequired extends Error {
  readonly question: AnyQuestion;
  constructor(question: AnyQuestion) {
    super(`Interaction required for "${question.key}": ${question.message}`);
    this.name = "InteractionRequired";
    this.question = question;
  }
}

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
