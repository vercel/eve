import type { ContextContainer } from "#context/container.js";
import { dispatchDynamicConnectionEvent } from "#context/dynamic-connection-lifecycle.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import type { HarnessEmissionState } from "#harness/emission.js";
import { getApprovalAuditState } from "#harness/approval-candidates.js";
import { shouldPrepareApprovalReplayTools } from "#harness/approval-delivery-coordinator.js";
import { getAuthorizationResult } from "#harness/authorization.js";
import {
  getPendingInputBatches,
  type PendingInputBatchEvent,
} from "#harness/pending-input-batches.js";
import type { HarnessSession, StepInput } from "#harness/types.js";
import {
  createSessionStartedEvent,
  createTurnStartedEvent,
  type RuntimeIdentity,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import type { ResolvedAgent } from "#runtime/types.js";

/** Binds dynamic connection lifecycle dispatch to one execution context. */
export function bindDynamicConnections(
  ctx: ContextContainer,
  agent: Pick<ResolvedAgent, "dynamicConnectionResolvers">,
) {
  const resolvers = agent.dynamicConnectionResolvers ?? [];
  const dispatch = (event: UnstampedMessageStreamEvent): Promise<void> =>
    dispatchDynamicConnectionEvent({ ctx, event, resolvers });

  return {
    dispatch,
    async rehydrate(
      state: HarnessEmissionState,
      runtime: RuntimeIdentity,
      betweenTurns: boolean,
      approval?: { readonly session: HarnessSession; readonly stepInput?: StepInput },
    ): Promise<void> {
      if (!state.sessionStarted) return;
      await dispatch(createSessionStartedEvent({ runtime }));
      const turn = betweenTurns
        ? approval === undefined
          ? undefined
          : resolvers.some((resolver) => resolver.eventNames.includes("turn.started"))
            ? approvalConnectionTurn(approval)
            : undefined
        : { sequence: state.sequence, turnId: activeTurnId(state) };
      if (turn === undefined) return;
      // Rebuild only connection callbacks. This is not a public turn boundary and
      // must not advance the harness or replace the approval responder's identity.
      await dispatch(createTurnStartedEvent(turn));
    },
  };
}

function approvalConnectionTurn(input: {
  readonly session: HarnessSession;
  readonly stepInput?: StepInput;
}): PendingInputBatchEvent | undefined {
  const now = Date.now();
  if (!shouldPrepareApprovalReplayTools({ ...input, now })) return;
  const requestIds = new Set([
    ...[
      ...(input.stepInput?.inputResponses ?? []),
      ...(input.stepInput?.attributedInputResponses ?? []).map(({ response }) => response),
    ]
      .filter((response) => response.optionId === "approve")
      .map((response) => response.requestId),
    ...getApprovalAuditState(input.session.state)
      .activeCandidates.filter(
        (candidate) =>
          candidate.expiresAt > now &&
          (candidate.status === "pending" ||
            candidate.authorizationChallenges?.some(
              (challenge) => getAuthorizationResult(challenge.name) !== undefined,
            )),
      )
      .map((candidate) => candidate.requestId),
  ]);
  const batches = getPendingInputBatches(input.session.state);
  const matching = batches.filter((batch) =>
    batch.requests.some(
      (request) => request.kind === "tool-approval" && requestIds.has(request.requestId),
    ),
  );
  // Text-only approval is supported only for a single pending batch.
  const turns = (matching.length === 0 && batches.length === 1 ? batches : matching)
    .map((batch) => batch.event)
    .filter((event): event is PendingInputBatchEvent => event !== undefined);
  const turn = turns[0];
  if (turns.some((event) => event.turnId !== turn?.turnId)) {
    throw new Error(
      "Cannot restore dynamic connections for approvals from different turns in one step.",
    );
  }
  return turn;
}
