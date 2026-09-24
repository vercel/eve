import type { SessionInboxAddress } from "#execution/session-inbox/address.js";
import type { DeliverHookPayload, DeliverPayload } from "#channel/types.js";
import { deserializeContext } from "#context/serialize.js";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import {
  type DurableSessionState,
  readDurableSession,
  replaceDurableSessionSnapshot,
} from "#execution/durable-session-store.js";
import { routeDeliverPayload } from "#subagents/hitl-proxy.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import {
  resumeWorkflowToolRunAnswers,
  resumeWorkflowToolRunDismissal,
} from "#execution/tools/workflow/answer.js";
import { getPendingCoordinationBatch } from "#harness/coordination.js";
import type { AnswerHookRoute } from "#harness/proxy-input-requests.js";
import {
  createInputResolvedEvent,
  encodeMessageStreamEvent,
  type InputResolution,
  stampMessageStreamEvent,
} from "#protocol/message.js";
import type { InputResponse } from "#shared/input.js";
import {
  getProxyInputRequests,
  isRemoteChildRouteToken,
  retireProxyInputRequests,
} from "#harness/proxy-input-requests.js";
import { resumeResolvedTaskClocks } from "#tasks/clock.js";
import { getTaskTable } from "#tasks/state.js";
import { findTask } from "#tasks/table.js";
import { answerRemoteTask } from "#tasks/transport.js";

export type RoutedDeliverResult =
  | {
      readonly kind: "cancel-turn";
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    }
  | {
      readonly kind: "continue";
      /** Tasks whose dismissible `ctx.ask()` question a plain message dismissed. */
      readonly dismissedTaskIds?: readonly string[];
      readonly remainder: DeliverHookPayload | undefined;
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    };

interface ChildBucket {
  readonly answerHook?: AnswerHookRoute;
  readonly childContinuationToken: string;
  readonly childSessionInbox?: SessionInboxAddress;
  readonly dismissedRequestIds: string[];
  readonly metadata: NonNullable<DeliverHookPayload["deliveryMetadata"]>[number][];
  readonly payloads: DeliverPayload[];
  readonly retireRequestIds: string[];
}

/** Splits an envelope and forwards descendant input to the children that asked for it. */
export async function routeProxiedDeliverStep(input: {
  readonly delivery: DeliverHookPayload;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly serializedContext?: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<RoutedDeliverResult> {
  "use step";
  let durableSession = readDurableSession(input.sessionState);
  const routes = getProxyInputRequests(durableSession.state);
  const dismissedTaskIds = new Set<string>();
  const sourceDelivery = input.delivery;
  const parentPayloads = new Map<number, DeliverPayload>();
  const children = new Map<string, ChildBucket>();
  let parentAction: { readonly kind: "cancel-turn" } | undefined;
  // Only a person's own message may answer or skip a pending question.
  const resolveMessage = sourceDelivery.caller === undefined;
  // Every payload routes against the same state, so an answer-hook request
  // resolved by an earlier payload is hidden from later ones; its hook accepts
  // one answer, and later messages must reach the parent instead.
  const resolvedQuestions = new Set<string>();

  for (const [sourcePayloadIndex, payload] of sourceDelivery.payloads.entries()) {
    const routed = routeDeliverPayload({
      allowRoute: (requestId) => !resolvedQuestions.has(requestId),
      payload,
      resolveMessage,
      state: durableSession.state,
    });
    parentAction ??= routed.parentAction;
    if (routed.forSelf !== undefined) parentPayloads.set(sourcePayloadIndex, routed.forSelf);

    for (const [childIndex, forChild] of routed.forChildren.entries()) {
      if (forChild.answerHook !== undefined) {
        for (const requestId of forChild.retireRequestIds) resolvedQuestions.add(requestId);
      }
      const key = [
        forChild.childContinuationToken,
        forChild.childSessionInbox?.sessionId ?? "",
      ].join("\0");
      const child = children.get(key) ?? {
        answerHook: forChild.answerHook,
        childContinuationToken: forChild.childContinuationToken,
        childSessionInbox: forChild.childSessionInbox,
        dismissedRequestIds: [],
        metadata: [],
        payloads: [],
        retireRequestIds: [],
      };
      const childPayloadIndex = child.payloads.length;
      child.payloads.push(forChild.payload);
      child.dismissedRequestIds.push(...(forChild.dismissedRequestIds ?? []));
      child.retireRequestIds.push(...forChild.retireRequestIds);
      if (routed.forSelf === undefined && childIndex === 0) {
        for (const metadata of sourceDelivery.deliveryMetadata ?? []) {
          if (metadata.payloadIndex === sourcePayloadIndex) {
            child.metadata.push({ ...metadata, payloadIndex: childPayloadIndex });
          }
        }
      }
      children.set(key, child);
    }
  }

  let retired = false;
  for (const child of children.values()) {
    if (isRemoteChildRouteToken(child.childContinuationToken)) {
      const taskId = routes.get(child.retireRequestIds[0] ?? "")?.taskId;
      const record =
        taskId === undefined ? undefined : findTask(getTaskTable(durableSession), taskId);
      const answered =
        record !== undefined &&
        (await answerRemoteTask({
          auth: sourceDelivery.auth ?? null,
          ctx: await deserializeContext(input.serializedContext ?? {}),
          inputResponses: coalesceDeliverPayloads(child.payloads).inputResponses ?? [],
          record,
        }));
      // An answer that did not reach the remote child stays answerable.
      if (answered) {
        durableSession = retireProxyInputRequests(durableSession, child.retireRequestIds);
        retired = true;
      }
      continue;
    }
    if (child.answerHook !== undefined) {
      const responses = coalesceDeliverPayloads(child.payloads).inputResponses ?? [];
      await resumeWorkflowToolRunAnswers(child.childContinuationToken, responses);
      if (child.dismissedRequestIds.length > 0) {
        await resumeWorkflowToolRunDismissal(child.childContinuationToken);
        for (const requestId of child.dismissedRequestIds) {
          const taskId = routes.get(requestId)?.taskId;
          if (taskId !== undefined) dismissedTaskIds.add(taskId);
        }
      }
      if (child.answerHook.question !== undefined) {
        await emitQuestionResolutions({
          dismissedRequestIds: child.dismissedRequestIds,
          responses,
          sessionState: durableSession.state,
          sessionWritable: input.sessionWritable,
        });
      }
      durableSession = retireProxyInputRequests(durableSession, child.retireRequestIds);
      retired = true;
      continue;
    }

    const childDelivery: DeliverHookPayload = {
      ...sourceDelivery,
      deliveryMetadata: child.metadata.length === 0 ? undefined : child.metadata,
      payloads: child.payloads,
    };
    await resumeSessionInbox(
      child.childSessionInbox ?? child.childContinuationToken,
      childDelivery,
    );
    // Successfully forwarded request IDs are retired so later deliveries
    // cannot route through stale entries.
    durableSession = retireProxyInputRequests(durableSession, child.retireRequestIds);
    retired = true;
  }

  if (retired) {
    // A task whose surfaced requests are all answered resumes its deadline clock.
    durableSession = resumeResolvedTaskClocks(durableSession, new Date().toISOString());
  }
  const context = {
    serializedContext: input.serializedContext ?? {},
    sessionState: retired
      ? replaceDurableSessionSnapshot({ session: durableSession, state: input.sessionState })
      : input.sessionState,
  };
  if (parentAction !== undefined) return { ...context, ...parentAction };
  const orderedParentPayloads = [...parentPayloads].sort(([a], [b]) => a - b);
  const parentMetadata = orderedParentPayloads.flatMap(([sourcePayloadIndex], payloadIndex) =>
    (sourceDelivery.deliveryMetadata ?? [])
      .filter((metadata) => metadata.payloadIndex === sourcePayloadIndex)
      .map((metadata) => ({ ...metadata, payloadIndex })),
  );
  const remainder =
    orderedParentPayloads.length === 0
      ? undefined
      : {
          ...sourceDelivery,
          deliveryMetadata: parentMetadata.length === 0 ? undefined : parentMetadata,
          payloads: orderedParentPayloads.map(([, payload]) => payload),
        };
  return dismissedTaskIds.size === 0
    ? { ...context, kind: "continue", remainder }
    : { ...context, dismissedTaskIds: [...dismissedTaskIds], kind: "continue", remainder };
}

// A `ctx.ask()` question is resolved by its workflow, not the harness, so the
// parent announces the resolution. A blocking run starts from the pending
// coordination batch, which carries the coordinates of its request.
async function emitQuestionResolutions(input: {
  readonly dismissedRequestIds: readonly string[];
  readonly responses: readonly InputResponse[];
  readonly sessionState: Parameters<typeof getPendingCoordinationBatch>[0];
  readonly sessionWritable: WritableStream<Uint8Array>;
}): Promise<void> {
  const event = getPendingCoordinationBatch(input.sessionState)?.event;
  if (event === undefined) return;
  const resolutions: InputResolution[] = [
    ...input.responses.map((response) => ({
      kind: "question" as const,
      outcome: "answered" as const,
      requestId: response.requestId,
      response,
    })),
    ...input.dismissedRequestIds.map((requestId) => ({
      kind: "question" as const,
      outcome: "ignored" as const,
      requestId,
    })),
  ];
  if (resolutions.length === 0) return;
  const writer = input.sessionWritable.getWriter();
  try {
    await writer.write(
      encodeMessageStreamEvent(
        stampMessageStreamEvent(createInputResolvedEvent({ resolutions, ...event })),
      ),
    );
  } finally {
    writer.releaseLock();
  }
}
