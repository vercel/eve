import type { ModelMessage } from "ai";

import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import type { InputRequest, InputResponse } from "#shared/input.js";
import type { ResolvedInputBatch } from "#harness/input-request-resolution.js";
import type { OpenRequestGroup, RequestGroupEvent } from "#harness/hitl/request-ledger.js";
import type { HarnessSession } from "#harness/types.js";

export type ToolResponsePart = Extract<ModelMessage, { role: "tool" }>["content"][number];

export interface ResolvedInputActionBatch {
  readonly event: RequestGroupEvent;
  readonly results: readonly RuntimeToolResultActionResult[];
}

export type RequestVerdict = {
  readonly messages: ModelMessage[];
  readonly rejectedActions?: readonly ResolvedInputActionBatch[];
  readonly resolvedInputs?: readonly ResolvedInputBatch[];
  readonly session: HarnessSession;
};

export type RequestVerdictReducerInput = {
  readonly batch: OpenRequestGroup;
  readonly messages: ModelMessage[];
  readonly resolveApprovalKey?: (request: InputRequest) => string | undefined;
  readonly responses: readonly InputResponse[];
  readonly session: HarnessSession;
};
