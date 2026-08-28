import type { SendTurnPayload } from "#client/types.js";
import { type EvalExecutionIdentity, withEvalExecutionIdentity } from "#protocol/eval-identity.js";

export type EvalIdentity = EvalExecutionIdentity;

export function attachEvalIdentity(
  input: SendTurnPayload,
  identity: EvalIdentity | undefined,
): SendTurnPayload {
  if (identity === undefined) return input;
  return {
    ...input,
    headers: withEvalExecutionIdentity(input.headers, identity),
  };
}
