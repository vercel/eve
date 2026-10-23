import type { SessionAuthContext } from "#channel/types.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import { contextStorage } from "#context/container.js";
import { AuthKey, SessionKey } from "#context/keys.js";
import {
  buildApprovalResponseAuth,
  handleApprovalResponsePolicyError,
} from "#execution/tool-auth.js";
import {
  getAuthorizationResult,
  isAuthorizationSignal,
  type AuthorizationChallenge,
} from "#harness/authorization.js";
import { responseAdmitted, responseSettled } from "#harness/interaction-facts.js";
import type { Transition } from "#harness/session-machine/commit.js";
import {
  stepForRequest,
  type ApprovalAsk,
  type SessionView,
  type SuspendedStep,
} from "#harness/session-machine/view.js";
import type { HarnessStepInput, HarnessToolLookup } from "#harness/types.js";
import { createLogger, logError } from "#internal/logging.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { Answer } from "#shared/input.js";

// Who may answer an approval. Without a response policy, only the person who asked; with one,
// whoever the policy allows. An answer a policy gates stays submitted, with who answered beside
// it, until the policy allows it (admitted) or refuses it (settled): the response row is the
// answer's state, and the record here is who gave it. The policy runs in the step after the
// answer arrives, so the answer is recorded before any policy work. The record outlives the
// policy's allowance until the answer settles, so the approved call can read who approved it.

const UNAUTHENTICATED_FEEDBACK = "Authentication is required to respond to this approval.";
const INVALID_FEEDBACK = "Respond to this approval with Approve or Cancel.";
const REQUESTER_ONLY_FEEDBACK =
  "Only the person who requested this action can respond to this approval.";
const UNAVAILABLE_REASON =
  "The tool this approval was for is no longer available, so the call won't run.";
const TEMPORARILY_UNAVAILABLE_REASON =
  "Approval authorization is temporarily unavailable. Please try again.";
const FAILED_REASON = "We couldn’t verify your response. Please try again.";
const EXPIRED_REASON = "The approval response expired. Please submit a new response.";
const AUTHORIZER_TIMEOUT_MS = 10_000;
const RESPONSE_TTL_MS = 10 * 60_000;

const log = createLogger("harness.hitl");

/** Who answered an approval its tool's response policy hasn't allowed yet. */
export interface PendingResponder {
  readonly responder: SessionAuthContext;
  readonly expiresAt: number;
  /** The sign-ins the policy asked the responder for. */
  readonly challenges?: readonly AuthorizationChallenge[];
}

/** What checking a delivery's answers concluded, by response. */
export interface ResponderCheck {
  /** Answers that stand now. */
  readonly admit: readonly string[];
  /** Answers refused before any policy ran, with why. */
  readonly refused: readonly { readonly responseId?: string; readonly reason: string }[];
  /** Answers a response policy weighs next step, with who gave each. */
  readonly weigh: Readonly<Record<string, PendingResponder>>;
}

/**
 * Checks who gave each of a delivery's answers. An approval takes only Approve or Cancel. Without
 * a response policy, it takes only its requester's answer, or anyone's when its requester is
 * anonymous; with one, it records an authenticated responder for the policy to weigh. Other
 * answers stand as they arrive, and an answer the session already holds was checked when it did.
 */
export function checkResponders(
  view: SessionView,
  delivery: HarnessStepInput | undefined,
  now: number,
): ResponderCheck {
  const admit: string[] = [];
  const refused: { responseId?: string; reason: string }[] = [];
  const weigh: Record<string, PendingResponder> = {};
  const seen = new Set<string>();
  for (const response of delivery?.answers ?? []) {
    const { responder: auth, responseId } = response;
    if (seen.has(responseId)) continue;
    seen.add(responseId);
    // A repeated delivery brings back an answer the session holds: it changes nothing, whoever
    // carried it, and a response policy already weighs it or has.
    if (view.projection.view.responses[responseId] !== undefined) continue;
    const step = stepForRequest(view, response.interactionId);
    const request = step?.requests.find((asked) => asked.interactionId === response.interactionId);
    if (step === undefined || request === undefined) {
      if (responseId !== undefined) admit.push(responseId);
      continue;
    }
    const decision = decisionOf(response);
    if (decision === undefined) {
      refused.push({ reason: INVALID_FEEDBACK, responseId });
      continue;
    }
    const gated = step.responseAuthRequiredRequestIds?.includes(request.interactionId) === true;
    if (!gated) {
      // An answer attributed to nobody stays nobody's; only an unattributed one is the caller's.
      const responder = auth !== undefined ? auth : currentResponder();
      const requester = step.requester ?? null;
      if (requester !== null && responder === null) {
        refused.push({ reason: UNAUTHENTICATED_FEEDBACK, responseId });
        continue;
      }
      if (requester !== null && responder !== null && !sameResponder(requester, responder)) {
        refused.push({ reason: REQUESTER_ONLY_FEEDBACK, responseId });
        continue;
      }
      if (responseId !== undefined) admit.push(responseId);
      continue;
    }
    // A response policy decides Cancel as well as Approve, so a responder it rejects can
    // neither approve nor cancel someone else's request.
    if (responseId === undefined) continue;
    const responder = auth !== undefined ? auth : buildCallbackContext().session.auth.current;
    if (responder === null) {
      refused.push({ reason: UNAUTHENTICATED_FEEDBACK, responseId });
      continue;
    }
    weigh[responseId] = { expiresAt: now + RESPONSE_TTL_MS, responder };
  }
  return { admit, refused, weigh };
}

/** What weighing the recorded answers concluded. */
export interface WeighedResponders extends Transition {
  /** Responders' sign-ins a policy asked for. */
  readonly challenges: readonly AuthorizationChallenge[];
  /** Approvals whose tool is gone: no answer can run their call. */
  readonly unavailable: readonly string[];
}

/**
 * Each recorded answer meets its response policy: allowed, it stands; refused or failed, it
 * settles with why; past its time, it expires. A policy that asks the responder to sign in waits
 * for the callback, then runs again.
 */
export async function weighResponders(
  view: SessionView,
  input: {
    readonly now: number;
    /** The entries of the step that asked, which carry the policy. */
    readonly toolsOf: (step: SuspendedStep | undefined) => Promise<HarnessToolLookup>;
  },
): Promise<WeighedResponders> {
  const tables = view.projection.view;
  const recorded = view.responders;
  const events: SessionEvent[] = [];
  const challenges: AuthorizationChallenge[] = [];
  const unavailable: string[] = [];
  const upsert: Record<string, PendingResponder> = {};
  const revised = revisedAnswers(view, input.now);
  for (const [responseId, pending] of Object.entries(recorded)) {
    const row = tables.responses[responseId];
    if (row?.status !== "submitted") continue;
    if (pending.expiresAt <= input.now) {
      events.push(responseSettled(responseId, "expired", EXPIRED_REASON));
      continue;
    }
    if (revised.has(responseId)) {
      events.push(responseSettled(responseId, "withdrawn", "revised"));
      continue;
    }
    if (
      (pending.challenges?.length ?? 0) > 0 &&
      !pending.challenges!.some((challenge) => getAuthorizationResult(challenge.name) !== undefined)
    )
      continue;
    const step = stepForRequest(view, row.interactionId);
    const request = step?.requests.find((asked) => asked.interactionId === row.interactionId);
    const decision = row.value?.optionId === "approve" ? "approve" : "deny";
    if (step === undefined || request === undefined) continue;
    const weighed = await weigh({
      decision,
      pending,
      request,
      responseId,
      step,
      toolsOf: input.toolsOf,
    });
    switch (weighed.kind) {
      case "allowed":
        events.push(responseAdmitted(responseId));
        break;
      case "refused":
        events.push(responseSettled(responseId, "refused", weighed.reason));
        break;
      case "failed":
        events.push(responseSettled(responseId, "failed", weighed.reason));
        break;
      case "unavailable":
        events.push(responseSettled(responseId, "failed", UNAVAILABLE_REASON));
        unavailable.push(request.interactionId);
        break;
      case "sign-in": {
        const asked = weighed.challenges.map((challenge) => ({
          ...challenge,
          candidateId: responseId,
        }));
        challenges.push(...asked);
        const expiresAt = Math.min(
          pending.expiresAt,
          ...asked
            .map((challenge) => Date.parse(challenge.challenge.expiresAt ?? ""))
            .filter(Number.isFinite),
        );
        upsert[responseId] = { ...pending, challenges: asked, expiresAt };
        break;
      }
    }
  }
  return {
    challenges,
    events,
    responders: upsert,
    turn: view.turn,
    unavailable,
  };
}

/**
 * The unweighed answers a later answer from the same responder to the same approval revises, so
 * a response policy runs once per person and approval however many answers they send.
 */
function revisedAnswers(view: SessionView, now: number): ReadonlySet<string> {
  const tables = view.projection.view;
  const latest = new Map<string, { readonly introducedAt: number; readonly responseId: string }>();
  const revised = new Set<string>();
  for (const [responseId, pending] of Object.entries(view.responders)) {
    const row = tables.responses[responseId];
    if (row?.status !== "submitted" || pending.expiresAt <= now) continue;
    // An answer waiting on its responder's sign-in has met its policy already.
    if ((pending.challenges?.length ?? 0) > 0) continue;
    const { authenticator, issuer, principalId, principalType } = pending.responder;
    const key = JSON.stringify([
      row.interactionId,
      authenticator,
      issuer ?? "",
      principalType,
      principalId,
    ]);
    const prior = latest.get(key);
    if (prior !== undefined && prior.introducedAt > row.introducedAt) {
      revised.add(responseId);
      continue;
    }
    if (prior !== undefined) revised.add(prior.responseId);
    latest.set(key, { introducedAt: row.introducedAt, responseId });
  }
  return revised;
}

type Weighed =
  | { readonly kind: "allowed" | "unavailable" }
  | { readonly kind: "refused" | "failed"; readonly reason: string }
  | { readonly kind: "sign-in"; readonly challenges: readonly AuthorizationChallenge[] };

async function weigh(input: {
  readonly decision: "approve" | "deny";
  readonly pending: PendingResponder;
  readonly request: ApprovalAsk;
  readonly responseId: string;
  readonly step: SuspendedStep;
  readonly toolsOf: (step: SuspendedStep | undefined) => Promise<HarnessToolLookup>;
}): Promise<Weighed> {
  let tools: HarnessToolLookup;
  try {
    tools = await input.toolsOf(input.step);
  } catch (error) {
    // A resolver or its infrastructure failed: the entry may still exist, so the request waits.
    logError(log, "approval tools could not be restored", error, {
      interactionId: input.request.interactionId,
    });
    return { kind: "failed", reason: TEMPORARILY_UNAVAILABLE_REASON };
  }
  const definition = tools.get(input.request.call.toolName);
  // Gone from the restored catalog: no response can approve the call, and it can't run.
  if (definition === undefined) return { kind: "unavailable" };
  const { approval } = definition;
  const policy =
    approval !== undefined && typeof approval !== "function" ? approval.response : undefined;
  if (policy === undefined) return { kind: "failed", reason: TEMPORARILY_UNAVAILABLE_REASON };
  try {
    const context = buildCallbackContext();
    const outcome = await withTimeout(
      policy({
        auth: buildApprovalResponseAuth({
          responder: input.pending.responder,
          scope: input.responseId,
        }),
        request: {
          callId: input.request.call.callId,
          interactionId: input.request.interactionId,
          principal: input.step.requester ?? null,
          toolInput: input.request.call.input,
          toolName: input.request.call.toolName,
        },
        response: { decision: input.decision, principal: input.pending.responder },
        session: {
          id: context.session.id,
          initiator: context.session.auth.initiator,
          parent: context.session.parent,
          turn: context.session.turn,
        },
      }),
    );
    if (outcome.status === "rejected") return { kind: "refused", reason: outcome.reason ?? "" };
    if (outcome.status !== "allowed") return { kind: "failed", reason: FAILED_REASON };
    return { kind: "allowed" };
  } catch (error) {
    const authorization = await handleApprovalResponsePolicyError(error).catch(() => undefined);
    if (isAuthorizationSignal(authorization))
      return { challenges: authorization.challenges, kind: "sign-in" };
    return { kind: "failed", reason: FAILED_REASON };
  }
}

function currentResponder(): SessionAuthContext | null {
  const context = contextStorage.getStore();
  return context?.get(AuthKey) ?? context?.get(SessionKey)?.auth.current ?? null;
}

function decisionOf(response: Answer): "approve" | "deny" | undefined {
  if (response.optionId === "approve") return "approve";
  if (response.optionId === "deny") return "deny";
  return undefined;
}

/** Whether two auth contexts name the same principal. */
export function sameResponder(left: SessionAuthContext, right: SessionAuthContext): boolean {
  return (
    left.authenticator === right.authenticator &&
    (left.issuer ?? "") === (right.issuer ?? "") &&
    left.principalType === right.principalType &&
    left.principalId === right.principalId
  );
}

async function withTimeout<T>(promise: Promise<T> | T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Approval response authorizer timed out.")),
          AUTHORIZER_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
