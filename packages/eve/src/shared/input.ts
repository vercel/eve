import { z } from "#compiled/zod/index.js";
import { conforming } from "#protocol/session-events/common.js";
import type { Answer } from "#protocol/session-events/families/response.js";

export type { Answer };

/** Zod schema for one answer. */
export const answerSchema = conforming<Answer>()(
  z
    .object({
      interactionId: z.string(),
      optionId: z.string().optional(),
      text: z.string().optional(),
    })
    .strict(),
);

declare const validatedAnswerBrand: unique symbol;

/** An answer proven to match the strict durable wire schema. */
export type ValidatedAnswer = Answer & { readonly [validatedAnswerBrand]: true };

/** Parses one answer and preserves schema validation in its static type. */
export function parseAnswer(value: unknown): ValidatedAnswer {
  return answerSchema.parse(value) as ValidatedAnswer;
}

/** Parses answer arrays whose element types were widened before delivery. */
export function parseAnswers(value: unknown): readonly ValidatedAnswer[] {
  return answerSchema
    .array()
    .parse(value)
    .map((answer) => answer as ValidatedAnswer);
}

type IsWidenedAnswer<TAnswer extends Answer> = keyof TAnswer extends keyof Answer
  ? keyof Answer extends keyof TAnswer
    ? Answer extends TAnswer
      ? true
      : false
    : false
  : false;

type StrictAnswer<TAnswer extends Answer> = TAnswer extends ValidatedAnswer
  ? TAnswer
  : IsWidenedAnswer<TAnswer> extends true
    ? never
    : TAnswer & { readonly [TKey in Exclude<keyof TAnswer, keyof Answer>]: never };

/** Rejects extra answer keys and imprecise arrays not proven by the strict schema. */
export type StrictAnswers<TAnswers extends readonly Answer[]> = TAnswers & {
  readonly [TIndex in keyof TAnswers]: TAnswers[TIndex] extends Answer
    ? StrictAnswer<TAnswers[TIndex]>
    : TAnswers[TIndex];
};

/** Returns true when a value matches the answer contract. */
export function isAnswer(value: unknown): value is ValidatedAnswer {
  return z.validate(answerSchema, value);
}

export { APPROVE_OPTION_ID, DENY_OPTION_ID } from "#protocol/interaction-options.js";
