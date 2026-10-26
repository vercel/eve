// Compatibility with session owners from before v27, which keep running on their own deployment
// (v27 refuses their checkpoints). They read a delivery's answers from `inputResponses`, keyed by
// `requestId`, which v27 renamed to `answers` keyed by `interactionId`; a v26 request id is the
// interaction id. Every delivery carries both, so a pressed answer reaches an old owner too.
// Delete once no pre-v27 deployment owns a session.

import type { DeliverPayload } from "#channel/types.js";

const PRE_V27_ANSWERS_KEY = "inputResponses";

/** The command with each payload's answers also under the name a pre-v27 owner reads. */
export function withPreV27Answers<T>(command: T): T {
  const value = command as { readonly kind?: unknown; payload?: unknown; payloads?: unknown };
  if (value.kind === "send" && isPayload(value.payload)) {
    return { ...command, payload: withAnswersAlias(value.payload) };
  }
  if (value.kind === "deliver" && Array.isArray(value.payloads)) {
    return { ...command, payloads: value.payloads.map(withAnswersAlias) };
  }
  return command;
}

/** The payload without the pre-v27 alias, which v27 code never reads. */
export function withoutPreV27Answers(payload: DeliverPayload): DeliverPayload {
  if (!(PRE_V27_ANSWERS_KEY in payload)) return payload;
  const { [PRE_V27_ANSWERS_KEY]: _alias, ...rest } = payload;
  return rest;
}

function withAnswersAlias(payload: DeliverPayload): DeliverPayload {
  if (payload.answers === undefined || payload.answers.length === 0) return payload;
  return {
    ...payload,
    [PRE_V27_ANSWERS_KEY]: payload.answers.map((answer) => {
      const legacy: { requestId: string; optionId?: string; text?: string } = {
        requestId: answer.interactionId,
      };
      if (answer.optionId !== undefined) legacy.optionId = answer.optionId;
      if (answer.text !== undefined) legacy.text = answer.text;
      return legacy;
    }),
  };
}

function isPayload(value: unknown): value is DeliverPayload {
  return value !== null && typeof value === "object";
}
