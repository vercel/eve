import type { SessionInboxAddress } from "#execution/session-inbox/address.js";
import { hasDelegatedSessionContext } from "#execution/delegated-session-context.js";
import type { DeliverHookPayload, DeliverPayload } from "#channel/types.js";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import {
  type DurableSessionState,
  readDurableSession,
  replaceDurableSessionSnapshot,
} from "#execution/durable-session-store.js";
import { routeDeliverPayload } from "#subagents/hitl-proxy.js";
import { sendTaskInboundPayload } from "#execution/tasks/parent/run-parent.js";
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
import { getBackgroundTasks } from "#harness/workflow-tool-runs.js";
import {
  createTaskInputRequestId,
  retireProxyInputRequests,
} from "#harness/proxy-input-requests.js";

export type RoutedDeliverResult =
  | {
      readonly kind: "cancel-turn";
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    }
  | {
      readonly kind: "continue";
      readonly remainder: DeliverHookPayload | undefined;
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    };

interface ChildBucket {
  readonly answerHook?: AnswerHookRoute;
  readonly childContinuationToken: string;
  readonly childSessionInbox?: SessionInboxAddress;
  readonly childResponseUrl?: string;
  readonly dismissedRequestIds: string[];
  readonly metadata: NonNullable<DeliverHookPayload["deliveryMetadata"]>[number][];
  readonly payloads: DeliverPayload[];
  readonly retireRequestIds: string[];
  readonly sourcePayloadIndexes: number[];
  readonly taskId?: string;
}

/** Splits an envelope and validates task routes before forwarding descendant input. */
export async function routeProxiedDeliverStep(input: {
  readonly delivery: DeliverHookPayload;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly serializedContext?: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<RoutedDeliverResult> {
  "use step";
  let durableSession = readDurableSession(input.sessionState);
  const sourceDelivery = input.delivery;
  const parentPayloads = new Map<number, DeliverPayload>();
  const children = new Map<string, ChildBucket>();
  let parentAction: { readonly kind: "cancel-turn" } | undefined;
  // Only a person's own message may answer or skip a pending question.
  const resolveMessage =
    !hasDelegatedSessionContext(input.serializedContext ?? {}) &&
    sourceDelivery.caller === undefined &&
    sourceDelivery.taskDeliveryId === undefined;
  // Every payload routes against the same state, so an answer-hook request
  // resolved by an earlier payload is hidden from later ones; its hook accepts
  // one answer, and later messages must reach the parent instead.
  const resolvedQuestions = new Set<string>();

  for (const [sourcePayloadIndex, payload] of sourceDelivery.payloads.entries()) {
    const routed = routeDeliverPayload({
      allowRoute: (requestId, route) =>
        !resolvedQuestions.has(requestId) &&
        (route.taskId === undefined ||
          getBackgroundTasks(durableSession.state).get(route.taskId) !== undefined),
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
        forChild.childResponseUrl ?? "",
        forChild.taskId ?? "",
      ].join("\0");
      const child = children.get(key) ?? {
        answerHook: forChild.answerHook,
        childContinuationToken: forChild.childContinuationToken,
        childSessionInbox: forChild.childSessionInbox,
        childResponseUrl: forChild.childResponseUrl,
        dismissedRequestIds: [],
        metadata: [],
        payloads: [],
        retireRequestIds: [],
        sourcePayloadIndexes: [],
        taskId: forChild.taskId,
      };
      const childPayloadIndex = child.payloads.length;
      child.payloads.push(forChild.payload);
      child.dismissedRequestIds.push(...(forChild.dismissedRequestIds ?? []));
      child.retireRequestIds.push(...forChild.retireRequestIds);
      child.sourcePayloadIndexes.push(sourcePayloadIndex);
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
    // A task-owned executor is addressed through its task controller. The
    // controller forwards the answer and clears `input_required` as one
    // durable decision, so its view cannot claim the child resumed first.
    const taskId = child.taskId;
    if (taskId !== undefined) {
      const entry = getBackgroundTasks(durableSession.state).get(taskId)?.run;
      if (entry === undefined) {
        mergeStrandedResponses(parentPayloads, child, taskId);
        continue;
      }
      const delivery = await sendTaskInboundPayload({
        taskInboxToken: entry.address.hookToken,
        payload: {
          auth: sourceDelivery.auth,
          childContinuationToken: child.childContinuationToken,
          childSessionInbox: child.childSessionInbox,
          childResponseUrl: child.childResponseUrl,
          inputResponses: coalesceDeliverPayloads(child.payloads).inputResponses ?? [],
          kind: "input-response",
          taskId,
        },
      });
      if (delivery === "unreachable") {
        mergeStrandedResponses(parentPayloads, child, taskId);
        continue;
      }
      durableSession = retireProxyInputRequests(durableSession, child.retireRequestIds);
      retired = true;
      continue;
    }

    if (child.answerHook !== undefined) {
      const responses = coalesceDeliverPayloads(child.payloads).inputResponses ?? [];
      await resumeWorkflowToolRunAnswers(child.childContinuationToken, responses);
      if (child.dismissedRequestIds.length > 0) {
        await resumeWorkflowToolRunDismissal(child.childContinuationToken);
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
  return { ...context, kind: "continue", remainder };
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

// Answers to a task that finished mid-flight rejoin the parent-local
// remainder, where the model sees them as stale rather than silently
// vanishing.
function mergeStrandedResponses(
  parentPayloads: Map<number, DeliverPayload>,
  child: ChildBucket,
  taskId: string,
): void {
  for (const [childPayloadIndex, payload] of child.payloads.entries()) {
    const sourcePayloadIndex = child.sourcePayloadIndexes[childPayloadIndex];
    if (sourcePayloadIndex === undefined) continue;
    const strandedResponses: InputResponse[] = (payload.inputResponses ?? []).map((response) => ({
      ...response,
      requestId: createTaskInputRequestId(taskId, response.requestId),
    }));
    if (strandedResponses.length === 0) continue;
    const forSelf = parentPayloads.get(sourcePayloadIndex);
    parentPayloads.set(sourcePayloadIndex, {
      ...forSelf,
      inputResponses: [...(forSelf?.inputResponses ?? []), ...strandedResponses],
    });
  }
}
