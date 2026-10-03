import { buildCallbackContext } from "#context/build-callback-context.js";
import {
  buildApprovalResponseAuth,
  handleApprovalResponsePolicyError,
} from "#execution/tool-auth.js";
import { isAuthorizationSignal } from "#harness/authorization.js";
import type { HumanInputEvent, Intake, PolicyRun } from "#harness/human-input/index.js";
import type { HarnessToolMap } from "#harness/types.js";

const POLICY_TIMEOUT_MS = 10_000;

/**
 * Runs the `approval.response` policy for one responder's answer and reports
 * what it did; human input reads that as the candidate's verdict. A policy
 * that needs the responder to sign in gets a sign-in scoped to the candidate,
 * so each candidate's sign-in settles only its own answer.
 */
export async function checkResponder(
  check: Extract<HumanInputEvent, { readonly type: "responder.check" }>,
  tools: HarnessToolMap,
): Promise<Extract<Intake, { readonly type: "responder.checked" }>> {
  return {
    candidateId: check.candidateId,
    ran: await runPolicy(check, tools),
    type: "responder.checked",
  };
}

async function runPolicy(
  check: Extract<HumanInputEvent, { readonly type: "responder.check" }>,
  tools: HarnessToolMap,
): Promise<PolicyRun> {
  const { candidateId, request } = check;
  const approval = tools.get(request.action.toolName)?.approval;
  const policy =
    approval !== undefined && typeof approval !== "function" ? approval.response : undefined;
  if (policy === undefined) return { kind: "missing" };
  try {
    const context = buildCallbackContext();
    const value = await withTimeout(
      policy({
        auth: buildApprovalResponseAuth({ responder: check.responder, scope: candidateId }),
        request: {
          callId: request.action.callId,
          principal: check.requester,
          requestId: request.requestId,
          toolInput: request.action.input,
          toolName: request.action.toolName,
        },
        response: { decision: check.decision, principal: check.responder },
        session: {
          id: context.session.id,
          initiator: context.session.auth.initiator,
          parent: context.session.parent,
          turn: context.session.turn,
        },
      }),
    );
    return { kind: "returned", value };
  } catch (error) {
    const signIn = await handleApprovalResponsePolicyError(error).catch(() => undefined);
    return isAuthorizationSignal(signIn)
      ? { challenges: signIn.challenges, kind: "threw" }
      : { kind: "threw" };
  }
}

async function withTimeout<T>(value: Promise<T> | T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(value),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Approval response policy timed out.")),
          POLICY_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
