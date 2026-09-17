export const EVE_EVAL_HEADER = "x-eve-eval";
export const EVE_EVAL_HEADER_VALUE = "1";

export function isEveEvalRequest(headers: Headers): boolean {
  return headers.get(EVE_EVAL_HEADER) === EVE_EVAL_HEADER_VALUE;
}
