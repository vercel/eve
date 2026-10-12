/**
 * Question reducer: an `ask_question` prompt. The complete rule set for
 * #1224's `owner.question.*` requests.
 */

import type { InputRequest } from "../harness-types.js";
import type { RequestReducer, Verdict } from "../types.js";

export interface QuestionSpec {
  /** The ask_question call: prompt, options, allowFreeform. Durable. */
  readonly request: InputRequest;
  /** The tool declared the originating actor may supersede with a message. */
  readonly supersedable: boolean;
}

export type QuestionOutcome =
  | { readonly status: "answered"; readonly optionId?: string; readonly text?: string }
  | { readonly status: "ignored" };

export const question: RequestReducer<QuestionSpec, QuestionOutcome> = {
  resolve(request, input): Verdict<QuestionOutcome> {
    switch (input.kind) {
      case "response": {
        const { optionId, text } = input.response;
        const options = request.spec.request.options;
        if (optionId !== undefined && !options?.some((option) => option.id === optionId))
          return { reject: "invalid" };
        if (optionId === undefined && text !== undefined && request.spec.request.allowFreeform !== true)
          return { reject: "invalid" };
        return { settle: { status: "answered", optionId, text } };
      }
      case "message":
        // owner.question.message.dismiss-superseded, actor-scoped:
        // another actor's chatter never dismisses someone's question.
        return input.actor === "originating" && request.spec.supersedable
          ? { dismiss: "superseded" }
          : "ignore";
      default:
        return "ignore";
    }
  },
};
