import { z } from "#compiled/zod/index.js";
import type {
  SubagentAuthorizationEvent,
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import { remoteChildRouteToken } from "#harness/proxy-input-requests.js";
import { inputRequestSchema } from "#shared/input.js";

// A remote child's input requests and authorization events reach its owner
// through the owner's callback route, the way a local child's reach the
// owner's inbox. The owner surfaces them to its client with the task's ID.

/** Requests one input batch may carry across the callback route. */
const MAX_REMOTE_INPUT_REQUESTS = 64;

const AUTHORIZATION_EVENT_TYPES = [
  "approval.candidate",
  "approval.settled",
  "authorization.required",
  "authorization.completed",
] as const;

const coordinatesSchema = {
  callId: z.string().min(1),
  sessionId: z.string().min(1),
  subagentName: z.string().min(1),
};

const inputRequestedCallbackSchema = z.object({
  ...coordinatesSchema,
  event: z.object({
    requests: z.array(inputRequestSchema).min(1).max(MAX_REMOTE_INPUT_REQUESTS),
    sequence: z.number().int().nonnegative(),
    stepIndex: z.number().int().nonnegative(),
    turnId: z.string().min(1),
  }),
  kind: z.literal("input.requested"),
});

const authorizationCallbackSchema = z.object({
  ...coordinatesSchema,
  event: z.object({
    data: z.record(z.string(), z.unknown()),
    type: z.enum(AUTHORIZATION_EVENT_TYPES),
  }),
  kind: z.literal("authorization.event"),
});

/** The body a remote child posts for one input batch. */
export type RemoteInputRequestedCallback = z.infer<typeof inputRequestedCallbackSchema>;

/** The body a remote child posts for one authorization event. */
export type RemoteAuthorizationCallback = Omit<
  z.infer<typeof authorizationCallbackSchema>,
  "event"
> & { readonly event: SubagentAuthorizationEvent };

/** Whether an event is one a remote child forwards as an authorization callback. */
export function isForwardedAuthorizationEvent(event: {
  readonly type: string;
}): event is SubagentAuthorizationEvent {
  return (AUTHORIZATION_EVENT_TYPES as readonly string[]).includes(event.type);
}

/**
 * Projects a remote child's HITL callback into the hook payload a local
 * child would send. Returns `undefined` for any other callback kind.
 */
export function projectRemoteHitlCallback(
  value: object,
): SubagentInputRequestHookPayload | SubagentAuthorizationEventHookPayload | Response | undefined {
  const kind = Reflect.get(value, "kind");
  if (kind === "input.requested") {
    const parsed = inputRequestedCallbackSchema.safeParse(value);
    if (!parsed.success) return invalid();
    const { callId, event, sessionId, subagentName } = parsed.data;
    return {
      callId,
      childContinuationToken: remoteChildRouteToken(sessionId),
      childSessionId: sessionId,
      event,
      kind: "subagent-input-request",
      source: { kind: "remote" },
      subagentName,
    };
  }
  if (kind === "authorization.event") {
    const parsed = authorizationCallbackSchema.safeParse(value);
    if (!parsed.success) return invalid();
    const { callId, event, sessionId, subagentName } = parsed.data;
    return {
      callId,
      childSessionId: sessionId,
      event: event as SubagentAuthorizationEvent,
      kind: "subagent-authorization-event",
      source: { kind: "remote" },
      subagentName,
    };
  }
  return undefined;
}

function invalid(): Response {
  return Response.json({ error: "Invalid input callback.", ok: false }, { status: 400 });
}
