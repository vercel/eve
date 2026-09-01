import type { DeliverHookPayload, DeliverPayload, SessionAuthContext } from "#channel/types.js";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import {
  type DurableSessionState,
  readDurableSession,
  replaceDurableSessionSnapshot,
} from "#execution/durable-session-store.js";
import { routeDeliverPayload } from "#execution/subagent-hitl-proxy.js";
import { sendTaskInboundPayload } from "#execution/tasks/parent/run-parent.js";
import { resumeSessionInbox } from "#execution/wire/session-inbox-resume.js";
import { resumeWorkflowToolRunAnswers } from "#execution/tools/workflow/answer.js";
import type { AnswerHookRoute } from "#harness/proxy-input-requests.js";
import type { InputResponse } from "#shared/input.js";
import { findSessionTaskEntry } from "#tasks/session-index.js";
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

type LegacyRoutedDeliverResult =
  | {
      readonly kind: "cancel-turn";
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    }
  | {
      readonly kind: "continue";
      readonly remainder: DeliverPayload | undefined;
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    };

interface ChildBucket {
  readonly answerHook?: AnswerHookRoute;
  readonly childContinuationToken: string;
  readonly childResponseUrl?: string;
  readonly metadata: NonNullable<DeliverHookPayload["deliveryMetadata"]>[number][];
  readonly payloads: DeliverPayload[];
  readonly retireRequestIds: string[];
  readonly sourcePayloadIndexes: number[];
  readonly taskId?: string;
}

/** Splits an envelope and validates task routes before forwarding descendant input. */
export function routeProxiedDeliverStep(input: {
  readonly delivery: DeliverHookPayload;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext?: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<RoutedDeliverResult>;
export function routeProxiedDeliverStep(input: {
  readonly auth?: SessionAuthContext | null;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly payload: DeliverPayload;
  readonly serializedContext?: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<LegacyRoutedDeliverResult>;
export async function routeProxiedDeliverStep(
  input:
    | {
        readonly delivery: DeliverHookPayload;
        readonly parentWritable: WritableStream<Uint8Array>;
        readonly serializedContext?: Record<string, unknown>;
        readonly sessionState: DurableSessionState;
      }
    | {
        readonly auth?: SessionAuthContext | null;
        readonly parentWritable: WritableStream<Uint8Array>;
        readonly payload: DeliverPayload;
        readonly serializedContext?: Record<string, unknown>;
        readonly sessionState: DurableSessionState;
      },
): Promise<LegacyRoutedDeliverResult | RoutedDeliverResult> {
  "use step";

  let durableSession = await readDurableSession(input.sessionState);
  const legacyInput = !("delivery" in input);
  const sourceDelivery: DeliverHookPayload =
    "delivery" in input
      ? input.delivery
      : { auth: input.auth, kind: "deliver", payloads: [input.payload] };
  const parentPayloads = new Map<number, DeliverPayload>();
  const children = new Map<string, ChildBucket>();
  let parentAction: { readonly kind: "cancel-turn" } | undefined;

  for (const [sourcePayloadIndex, payload] of sourceDelivery.payloads.entries()) {
    const routed = routeDeliverPayload({
      allowRoute: (_requestId, route) =>
        route.taskId === undefined ||
        findSessionTaskEntry(durableSession.state, route.taskId) !== undefined,
      payload,
      state: durableSession.state,
    });
    parentAction ??= routed.parentAction;
    if (routed.forSelf !== undefined) parentPayloads.set(sourcePayloadIndex, routed.forSelf);

    for (const [childIndex, forChild] of routed.forChildren.entries()) {
      const key =
        forChild.taskId === undefined
          ? forChild.childContinuationToken
          : [
              forChild.childContinuationToken,
              forChild.childResponseUrl ?? "",
              forChild.taskId,
            ].join("\0");
      const child = children.get(key) ?? {
        answerHook: forChild.answerHook,
        childContinuationToken: forChild.childContinuationToken,
        childResponseUrl: forChild.childResponseUrl,
        metadata: [],
        payloads: [],
        retireRequestIds: [],
        sourcePayloadIndexes: [],
        taskId: forChild.taskId,
      };
      const childPayloadIndex = child.payloads.length;
      child.payloads.push(forChild.payload);
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
      const entry = findSessionTaskEntry(durableSession.state, taskId);
      if (entry === undefined) {
        mergeStrandedResponses(parentPayloads, child, taskId);
        continue;
      }
      const delivery = await sendTaskInboundPayload({
        taskInboxToken: entry.taskInboxToken,
        payload: {
          auth: sourceDelivery.auth,
          childContinuationToken: child.childContinuationToken,
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
      await resumeWorkflowToolRunAnswers(
        child.childContinuationToken,
        coalesceDeliverPayloads(child.payloads).inputResponses,
      );
      durableSession = retireProxyInputRequests(durableSession, child.retireRequestIds);
      retired = true;
      continue;
    }

    const childDelivery: DeliverHookPayload = {
      ...sourceDelivery,
      deliveryMetadata: child.metadata.length === 0 ? undefined : child.metadata,
      payloads: child.payloads,
    };
    await resumeSessionInbox(child.childContinuationToken, childDelivery);
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
      : legacyInput
        ? coalesceDeliverPayloads(orderedParentPayloads.map(([, payload]) => payload))
        : {
            ...sourceDelivery,
            deliveryMetadata: parentMetadata.length === 0 ? undefined : parentMetadata,
            payloads: orderedParentPayloads.map(([, payload]) => payload),
          };
  return { ...context, kind: "continue", remainder };
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
