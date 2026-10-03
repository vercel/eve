import type { SessionAuthContext } from "#channel/types.js";
import type { HarnessToolMap } from "#harness/types.js";
import type { InputRequest } from "#shared/input.js";

import type { Interrupt, RequestAt } from "./index.js";

// The tool approval rules. Until approvals are rebuilt, a model step that asks
// for one fails its turn; this reads what the step's requests ask.

/**
 * What a model step's approval requests ask, read from the tools that made
 * them: whether a response policy decides who may answer.
 */
export function approvalsRequested(input: {
  readonly at: RequestAt;
  readonly requester: SessionAuthContext | null;
  readonly requests: readonly InputRequest[];
  readonly tools: HarnessToolMap;
}): Extract<Interrupt, { readonly type: "approvals.requested" }> {
  const responsePolicyRequestIds: string[] = [];
  for (const request of input.requests) {
    const tool = input.tools.get(request.action.toolName);
    const approval = tool?.approval;
    if (
      approval !== undefined &&
      typeof approval !== "function" &&
      approval.response !== undefined
    ) {
      responsePolicyRequestIds.push(request.requestId);
    }
  }
  return {
    at: input.at,
    requester: input.requester,
    requests: input.requests,
    responsePolicyRequestIds,
    type: "approvals.requested",
  };
}
