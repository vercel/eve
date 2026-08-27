/**
 * Where the kernel runs: the SAME seam as today. This file is the answer to
 * "HITL logic runs after the current step loop ends and before the next one
 * — we'd need to converge": we do not move the seam, we replace what runs
 * inside it.
 *
 * Today (tool-loop.ts:1050):
 *
 *   coordinateApprovalDelivery(...)        // candidates, policies, challenges
 *   resolvePendingInput({                  // route by domain → 3 resolvers
 *     deferMessagesWhileApprovalsPending,  //   approval-input-requests.ts
 *     resolveApprovalKey,                  //   question-input-requests.ts
 *     session, stepInput,                  //   session-limit-input-requests.ts
 *   })
 *   → ResolvePendingInputResult            // then the model step runs
 *
 * Target (same call site, same contract):
 *
 *   resolvePendingInputViaKernel({ session, stepInput, tools })
 *   → ResolvePendingInputResult
 *
 * The park side is likewise unmoved: the model step still ends, the harness
 * still calls appendPendingInputBatch (which raiseRows consumes at the next
 * pass). Nothing about WHEN HITL runs changes — mid-step approval gating
 * still surfaces at step end via AI SDK approval parts, and the body-run
 * owner is only reachable in background tasks where the step already ended
 * with a receipt. Convergence is: one interpreter inside the existing seam,
 * instead of coordinator + router + three domain resolvers.
 */

import type {
  HarnessSession,
  HarnessToolMap,
  ModelMessage,
  ResolvePendingInputResult,
  StepInput,
} from "./harness-types.js";
import { interpretDelivery } from "./kernel.js";
import { ledgerFromSessionState } from "./ledger.js";
import type { LedgerEffect } from "./types.js";
import { variants, type ApprovalSpec } from "./variants.js";

export async function resolvePendingInputViaKernel(input: {
  readonly history?: readonly ModelMessage[];
  readonly session: HarnessSession;
  readonly stepInput?: StepInput;
  readonly tools: HarnessToolMap;
}): Promise<ResolvePendingInputResult> {
  const baseHistory = [...(input.history ?? input.session.history)];
  let ledger = ledgerFromSessionState(input.session.state);
  if (ledger.rows.every((row) => row.state.phase !== "open")) {
    return { outcome: "continue", messages: baseHistory, session: input.session };
  }

  // Per-tool dynamic approval: inject each approval row's resolved policy
  // from the live tool map — the reducer never sees the registry. This is
  // resolveApprovalKeyFromTools generalized to the whole policy surface.
  ledger = {
    ...ledger,
    rows: ledger.rows.map((row) =>
      row.kind === "approval"
        ? { ...row, spec: bindApprovalPolicy(row.spec as ApprovalSpec, input.tools) }
        : row,
    ),
  };

  const { ledger: next, effects } = await interpretDelivery({
    ledger,
    responses: input.stepInput?.inputResponses ?? [],
    message:
      input.stepInput?.message !== undefined
        ? { actor: actorOf(input.stepInput, input.session) }
        : undefined,
    variants,
  });

  // Persist the ledger back onto session state, then translate effects into
  // today's result contract (state before effects):
  //  - claim-continuation → splice the group's withheld responseMessages +
  //    member outcome tool parts into `messages`; remove the batch
  //    (appendResolvedBatchTranscript / removePendingInputBatches semantics)
  //  - settled(denied|cancelled) → rejectedActions entries
  //    (TOOL_EXECUTION_DENIED / _CANCELLED parts, attributed to batch.event)
  //  - reject-response(context-turn) → synthetic context message appended;
  //    (drop) → event only
  //  - consume-message → outcome "resolved" with consumedMessage: true
  //  - no claims and no message → outcome "unresolved" (park continues);
  //    a message with open approvals still defers via the same
  //    deferMessagesWhileApprovalsPending rule the caller passes today
  return translateEffects({ baseHistory, effects, ledger: next, session: input.session });
}

/**
 * Owner delivery is the second half of the seam. Effects targeting rows whose
 * owner is not "session" do not splice into the transcript — they serialize
 * to the owner's hook token:
 *
 *   settled(row)  → resumeSessionInbox(row.owner, { inputResponses: [...] })
 *   dismissed(row)→ resumeSessionInbox(row.owner, { dismissed: [row.id] })
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

declare function bindApprovalPolicy(spec: ApprovalSpec, tools: HarnessToolMap): ApprovalSpec;
declare function actorOf(
  stepInput: StepInput,
  session: HarnessSession,
): "originating" | "other" | "anonymous";
