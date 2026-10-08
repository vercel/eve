import type { AuthorizationChallenge } from "#harness/authorization.js";
import { sameStep, type StepCoordinates, type SuspendedStep } from "./view.js";
import { hitlStepKey } from "#harness/hitl/record.js";
import type { HumanInputState, OpenApproval } from "#harness/hitl/state.js";
import { readTurnState, type TurnState } from "#harness/session-machine/state.js";
import { SESSION_PROJECTION_STATE_KEY, storedProjection } from "#harness/session-machine/view.js";
import { getSessionUsage } from "#harness/turn-tag-state.js";
import type { SessionStateMap } from "#harness/types.js";
import { foldSession } from "#protocol/session-projection.js";
import {
  clearLegacyParkingState,
  getProxyInputRequests,
  hasLegacyParkingState,
  LEGACY_BATCH_KEY,
  LEGACY_GRANTS_KEY,
  legacyApprovalAudit,
  legacyRequestedEvents,
  mergeApprovalAudits,
  parseLegacyBatch,
  readState,
  STATE_KEY,
} from "./migrate-legacy.js";
import type { SessionView } from "./view.js";
import { writeTurnState } from "./state.js";

/** Pure hydration: old keys and their replacement belong to one atomic checkpoint write. */
function upgradeLegacyState(
  state: SessionStateMap | undefined,
): { readonly state: SessionStateMap; readonly turn: TurnState } | undefined {
  if (!hasLegacyParkingState(state)) return undefined;
  const session = { state };
  const previous = storedProjection(session.state);
  const projection = legacyRequestedEvents(session.state, previous).reduce(foldSession, previous);
  const turn = readTurnState(session.state);
  const pending = session.state?.["eve.runtime.pendingAuthorization"] as
    | { readonly challenges: readonly AuthorizationChallenge[] }
    | undefined;
  const upgraded = projectLegacyState(
    {
      projection,
      turn,
      signIns: pending?.challenges ?? [],
      relayedRequestIds: new Set(Object.keys(turn.hitl?.relayedRoutes ?? {})),
      usage: getSessionUsage(session),
    },
    session.state,
  );
  const migrated: Record<string, unknown> = {
    ...clearLegacyParkingState(session.state),
    [SESSION_PROJECTION_STATE_KEY]: projection,
  };
  if (upgraded.signIns.length === 0) delete migrated["eve.runtime.pendingAuthorization"];
  else migrated["eve.runtime.pendingAuthorization"] = { challenges: upgraded.signIns };
  return {
    state: migrated,
    turn: {
      ...upgraded.turn,
      hitl: {
        ...upgraded.turn.hitl,
        audit: mergeApprovalAudits(legacyApprovalAudit(state), upgraded.turn.hitl?.audit),
      },
    },
  };
}

/** Pure upgrade projection. Hydration will apply it and clear the old keys in the migration phase. */
function projectLegacyState(
  view: SessionView,
  state: SessionStateMap | undefined,
): { readonly turn: TurnState; readonly signIns: readonly AuthorizationChallenge[] } {
  const read = readState(state);
  const approval = Object.values(read.requests).find((request) => request.kind === "tool-approval");
  // Old releases committed the asking transcript before parking its approval; preserve the
  // empty originating step so cancellation still commits the missing denied-call results.
  const legacy =
    read.held === undefined && approval !== undefined
      ? { ...read, held: { at: approval.at, messages: [] } }
      : read;
  const hasHumanState = [STATE_KEY, LEGACY_BATCH_KEY, LEGACY_GRANTS_KEY].some(
    (key) => state !== undefined && Object.hasOwn(state, key),
  );
  const global = hasHumanState ? projectedTurn(view, legacy) : view.turn;
  const turn =
    !hasHumanState || legacy.held === undefined
      ? global
      : projectedTurn({ ...view, turn: global }, legacy, legacy.held.at);
  const proxyRoutes = Object.fromEntries(
    [...getProxyInputRequests(state)].map(([id, route]) => [
      id,
      {
        childContinuationToken: route.childContinuationToken,
        childSessionInbox: route.childSessionInbox,
        remote: route.remote,
        inputSource: route.inputSource,
        runId: route.runId,
        control: route.workflowAsk?.control,
      },
    ]),
  );
  return {
    turn: {
      ...turn,
      suspended:
        read.held === undefined && approval !== undefined
          ? turn.suspended.map((step) =>
              sameStep(step.event, approval.at)
                ? { ...step, transcriptCommitted: true as const }
                : step,
            )
          : turn.suspended,
      grants: [...new Set([...turn.grants, ...view.turn.grants])],
      queued: view.turn.queued ?? turn.queued,
      hitl: {
        ...turn.hitl,
        audit: view.turn.hitl?.audit ?? turn.hitl?.audit,
        relayedRoutes: {
          ...proxyRoutes,
          ...Object.fromEntries(
            Object.entries(legacy.requests).flatMap(([id, request]) =>
              request.kind === "relayed" ? [[id, request.route]] : [],
            ),
          ),
          ...view.turn.hitl?.relayedRoutes,
        },
        relayedAuthorizations: {
          ...legacy.relayedAuthorizations,
          ...view.turn.hitl?.relayedAuthorizations,
        },
      },
    },
    signIns: hasHumanState
      ? projectedSignIns(view, { grants: [], requests: {} }, legacy)
      : view.signIns,
  };
}

/** Pure, idempotent checkpoint upgrade; step-side reads are the runtime entry point. */
export function migrateSessionState<T extends { readonly state?: SessionStateMap }>(session: T): T {
  if (
    session.state?.[LEGACY_BATCH_KEY] !== undefined &&
    parseLegacyBatch(session.state[LEGACY_BATCH_KEY]) === undefined
  ) {
    throw new Error("Malformed legacy coordination batch; cannot resume session");
  }
  const migrated = upgradeLegacyState(session.state);
  return migrated === undefined
    ? session
    : writeTurnState({ ...session, state: migrated.state }, migrated.turn);
}

/** Fold the rule lens back into execution metadata; only applyTransition persists it. */
function projectedTurn(view: SessionView, state: HumanInputState, at?: StepCoordinates): TurnState {
  const approvals = Object.values(state.requests).filter(
    (request): request is OpenApproval => request.kind === "tool-approval",
  );
  const suspended = [...view.turn.suspended];
  const steps = { ...view.turn.hitl?.steps };
  if (at !== undefined) {
    const key = hitlStepKey(at);
    if (approvals.length === 0) delete steps[key];
    else
      steps[key] = {
        approvalKeys: Object.fromEntries(
          approvals.map((approval) => [approval.request.requestId, approval.approvalKey]),
        ),
        answers: Object.fromEntries(
          approvals.flatMap((approval) =>
            approval.answer === undefined ? [] : [[approval.request.requestId, approval.answer]],
          ),
        ),
      };
  }
  if (at !== undefined) {
    const index = suspended.findIndex((step) => sameStep(step.event, at));
    if (state.held === undefined) {
      if (index >= 0) suspended.splice(index, 1);
    } else {
      const previous = index < 0 ? undefined : suspended[index];
      const next: SuspendedStep = {
        ...previous,
        event: at,
        messages: state.held.messages,
        requests: approvals.map((approval) => approval.request),
        tasks: state.held.runtime?.tasks ?? [],
        approvers: state.held.runtime?.approvers,
        approved: state.held.approved,
        following: state.held.following,
        requester: approvals[0]?.requester ?? previous?.requester,
        responseAuthRequiredRequestIds: approvals
          .filter((approval) => approval.responsePolicy === true)
          .map((approval) => approval.request.requestId),
      };
      if (index < 0) suspended.push(next);
      else suspended[index] = next;
    }
  }
  const priorIds = new Set(
    at === undefined
      ? []
      : view.turn.suspended
          .find((step) => sameStep(step.event, at))
          ?.requests.map((request) => request.requestId),
  );
  const activeCandidates = { ...view.turn.hitl?.audit?.activeCandidates };
  for (const [id, candidate] of Object.entries(activeCandidates)) {
    if (priorIds.has(candidate.requestId)) delete activeCandidates[id];
  }
  Object.assign(activeCandidates, state.audit?.activeCandidates);
  const audit = state.audit === undefined ? undefined : { ...state.audit, activeCandidates };
  return {
    ...view.turn,
    suspended,
    grants: state.grants,
    queued: state.queued,
    hitl: {
      ...view.turn.hitl,
      steps,
      audit,
      ...(at === undefined && {
        relayedRoutes: Object.fromEntries(
          Object.entries(state.requests).flatMap(([id, request]) =>
            request.kind === "relayed" ? [[id, request.route]] : [],
          ),
        ),
        relayedAuthorizations: state.relayedAuthorizations,
      }),
    },
  };
}

function projectedSignIns(
  view: SessionView,
  before: HumanInputState,
  after: HumanInputState,
): readonly AuthorizationChallenge[] {
  const removed = new Set(
    Object.entries(before.requests)
      .filter(([, request]) => request.kind === "authorization")
      .map(([id]) => id),
  );
  for (const candidate of Object.values(before.audit?.activeCandidates ?? {}))
    for (const challenge of candidate.authorizations ?? [])
      removed.add(challenge.attemptId ?? challenge.name);
  const remaining = view.signIns.filter(
    (challenge) => !removed.has(challenge.attemptId ?? challenge.name),
  );
  const added = Object.values(after.requests).flatMap((request) =>
    request.kind === "authorization" ? [request.challenge] : [],
  );
  added.push(
    ...Object.values(after.audit?.activeCandidates ?? {}).flatMap(
      (candidate) => candidate.authorizations ?? [],
    ),
  );
  return [...remaining, ...added];
}
