/**
 * Where the interpreter runs: the same call site as today. This file is the answer to
 * "HITL logic runs after the current step loop ends and before the next one
 * — we would need to converge": we do not move the call site, we replace what runs
 * inside it.
 *
 * Today (tool-loop.ts:1050):
 *
 *   coordinateApprovalDelivery(...)        // attempts, policies, authorizations
 *   resolvePendingInput({                  // route by domain → 3 resolvers
 *     deferMessagesWhileApprovalsPending,  //   approval-input-requests.ts
 *     resolveApprovalKey,                  //   question-input-requests.ts
 *     session, stepInput,                  //   session-limit-input-requests.ts
 *   })
 *   → ResolvePendingInputResult            // then the model step runs
 *
 * Target (same call site, same contract):
 *
 *   resolvePendingInputViaInterpreter({ session, stepInput, tools })
 *   → ResolvePendingInputResult
 *
 * The park side is likewise unmoved: the model step still ends, the harness
 * still calls appendPendingInputBatch (which createRequests consumes at the next
 * pass). Nothing about WHEN HITL runs changes — mid-step approval gating
 * still surfaces at step end via AI SDK approval parts, and the body-run
 * owner is only reachable in background tasks where the step already ended
 * with a receipt. Convergence is: one interpreter behind the existing call site,
 * instead of coordinator + router + three domain resolvers.
 */

import type {
  HarnessSession,
  HarnessToolMap,
  ModelMessage,
  ResolvePendingInputResult,
  StepInput,
} from "./harness-types.js";
import { interpretDelivery } from "./interpret.js";
import { ledgerFromSessionState } from "./ledger.js";
import type { LedgerEffect } from "./types.js";
import { reducers, type ApprovalSpec } from "./reducers/index.js";

export async function resolvePendingInputViaInterpreter(input: {
  readonly history?: readonly ModelMessage[];
  readonly session: HarnessSession;
  readonly stepInput?: StepInput;
  readonly tools: HarnessToolMap;
}): Promise<ResolvePendingInputResult> {
  const baseHistory = [...(input.history ?? input.session.history)];
  let ledger = ledgerFromSessionState(input.session.state);
  const hasOpenRequest = ledger.requests.some((request) => request.state.phase === "open");
  const hasReadyGroup = ledger.groups.some((group) => group.completion === "ready");
  if (!hasOpenRequest && !hasReadyGroup) {
    return { outcome: "continue", messages: baseHistory, session: input.session };
  }

  // Per-tool dynamic approval: inject each approval request's resolved policy
  // from the live tool map — the reducer never sees the registry. This is
  // resolveApprovalKeyFromTools generalized to the whole policy surface.
  ledger = {
    ...ledger,
    requests: ledger.requests.map((request) =>
      request.kind === "approval"
        ? { ...request, spec: bindApprovalPolicy(request.spec as ApprovalSpec, input.tools) }
        : request,
    ),
  };

  const { ledger: next, effects } = await interpretDelivery({
    ledger,
    deliveryId: deliveryIdOf(input.stepInput),
    responses: input.stepInput?.inputResponses ?? [],
    message:
      input.stepInput?.message !== undefined
        ? { actor: actorOf(input.stepInput, input.session) }
        : undefined,
    reducers,
  });

  // Persist the ledger back onto session state, then translate effects into
  // today's result contract (state before effects):
  //  - deliver-group → idempotently splice the group's withheld responseMessages +
  //    member outcome tool parts into `messages`; remove the batch
  //    (appendResolvedBatchTranscript / removePendingInputBatches semantics)
  //  - settled(denied|cancelled) → rejectedActions entries
  //    (TOOL_EXECUTION_DENIED / _CANCELLED parts, attributed to batch.event)
  //  - reject-response(context-turn) → synthetic context message appended;
  //    (drop) → event only
  //  - consume-message → outcome "resolved" with consumedMessage: true
  //  - no ready-group delivery and no message → outcome "unresolved" (park continues);
  //    a message with open approvals still defers via the same
  //    deferMessagesWhileApprovalsPending rule the caller passes today
  return translateEffects({ baseHistory, effects, ledger: next, session: input.session });
}

/**
 * Owner delivery is the second half of the call site. Group delivery for an owner other than "session" does not splice into the
 * transcript. It serializes to the owner's hook token:
 *
 *   deliver-group(group) → deliverToOwner(group.owner, group.id, outcomes)
 *   success              → acknowledgeGroupDelivery(group.id)
 *
 * For a body-run owner that payload resolves/rejects the awaited
 * ctx.request promise; for a child session it is today's
 * deliverTaskInputResponsesStep wire, unchanged.
 */
declare function translateEffects(input: {
  readonly baseHistory: ModelMessage[];
  readonly effects: readonly LedgerEffect[];
  readonly ledger: ReturnType<typeof ledgerFromSessionState>;
  readonly session: HarnessSession;
}): ResolvePendingInputResult;

/**
 * Late-binds the tool's CURRENT response policy onto an approval request's spec
 * for this pass only — the policy is never persisted. Same lookup
 * `authorizeCandidate` performs today
 * (approval-delivery-coordinator.ts:334); dynamic tools resolve here iff
 * they are advertised in the live map for this step. A tool absent from the
 * map leaves `responsePolicy` undefined and the reducer applies the
 * ephemerality rule recorded at park time: settle directly when
 * `responseAuthRequired` is false, fail closed (`policy-failed`, request stays
 * open and answerable after a redeploy) when true.
 */
function bindApprovalPolicy(spec: ApprovalSpec, tools: HarnessToolMap): ApprovalSpec {
  const tool = readTool(tools, spec.request.action.toolName);
  const response = tool?.approval?.response;
  if (response === undefined) return { ...spec, responsePolicy: undefined };
  return {
    ...spec,
    responsePolicy: async ({ responder, request }) =>
      response({
        // buildApprovalResponseAuth / buildCallbackContext wrapping elided;
        // the interpreter owns timeout + throw → policy-failed conversion.
        responder,
        request: {
          callId: request.action.callId,
          requestId: request.requestId,
          toolInput: request.action.input,
          toolName: request.action.toolName,
        },
      }),
  };
}

/**
 * Narrows `HarnessToolMap.get(name)?.approval` to configuration shape:
 * a bare ApprovalPolicy function has no response policy
 * (resolveApprovalPolicy semantics — request policy only).
 */
declare function readTool(
  tools: HarnessToolMap,
  toolName: string,
): { readonly approval?: { readonly response?: RawResponsePolicy } } | undefined;
type RawResponsePolicy = (input: {
  readonly responder: unknown;
  readonly request: {
    readonly callId: string;
    readonly requestId: string;
    readonly toolInput: Record<string, unknown>;
    readonly toolName: string;
  };
}) => Promise<import("./reducers/index.js").ApprovalPolicyResult>;

declare function actorOf(
  stepInput: StepInput,
  session: HarnessSession,
): "originating" | "other" | "anonymous";
/** Server-assigned admission id for the delivery this step input carries. */
declare function deliveryIdOf(stepInput: StepInput | undefined): string;
