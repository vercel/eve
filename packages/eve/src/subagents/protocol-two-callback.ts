// What a remote child on remote agent protocol 2 relays about its people's input, read as the
// interaction facts a v27 child relays. Such a child posts its requests as
// `subagent-input-request` and how they and its sign-ins went as `subagent-authorization-event`;
// this session mirrors both the way it mirrors a v27 child's `subagent-interaction`.
//
// A protocol 2 child decides only its tool approvals and sign-ins here: it relays no
// settlement for a question or budget prompt, so the forwarding session settles those as it
// forwards their answer (`routeProxiedDeliverStep`). Its answers go back as `inputResponses`
// (`respondToRemoteAgentSession`).
//
// Delete once no remote agent this one calls speaks protocol 2.

import { z } from "#compiled/zod/index.js";
import type { RelayedInteractionEvent, SubagentInteractionHookPayload } from "#channel/types.js";
import { fact } from "#harness/facts.js";
import type { InteractionKind } from "#protocol/session-events/families/interaction.js";
import type { Answer, ResponseOutcome } from "#protocol/session-events/families/response.js";
import {
  v26InteractionOutcome,
  v26InteractionRequest,
  v26SignInOutcome,
  v26SignInRequest,
} from "#protocol/v26-interactions.js";
import { jsonObjectSchema } from "#shared/json-schemas.js";

/** The callback kinds a protocol 2 child posts about its people's input. */
export const PROTOCOL_TWO_INPUT_CALLBACK_KINDS: ReadonlySet<unknown> = new Set([
  "subagent-input-request",
  "subagent-authorization-event",
]);

const position = { sequence: z.number(), stepIndex: z.number(), turnId: z.string() };

// Protocol 2's v26 request: what the child asks, and the tool call it asks about.
const v26RequestSchema = z.object({
  action: z.object({
    callId: z.string().min(1),
    input: jsonObjectSchema,
    kind: z.literal("tool-call"),
    toolName: z.string().min(1),
  }),
  allowFreeform: z.boolean().optional(),
  display: z.string().optional(),
  kind: z.enum(["question", "session-limit", "tool-approval"]),
  options: z
    .array(
      z.object({
        description: z.string().optional(),
        id: z.string(),
        label: z.string(),
        style: z.string().optional(),
      }),
    )
    .optional(),
  prompt: z.string(),
  requestId: z.string().min(1),
});

const v26ResponseSchema = z.object({
  optionId: z.string().optional(),
  requestId: z.string(),
  text: z.string().optional(),
});

// The callback token grants access to the pending turn. Validate remote input
// before handing it to the parent; the child session ID is not authority.
const inputRequestCallbackSchema = z.object({
  callId: z.string().min(1),
  childContinuationToken: z.string().min(1),
  childSessionId: z.string().min(1),
  childSessionInbox: z
    .object({ sessionId: z.string().min(1) })
    .strict()
    .optional(),
  inputSource: z.string().min(1).optional(),
  // A grandchild's binding, which a protocol 2 child relays with that grandchild's requests. This
  // session answers through its own binding to the child, so only a passthrough keeps it.
  remote: z
    .object({
      forwardPrincipal: z.boolean().optional(),
      name: z.string().min(1),
      resolverId: z.string().min(1).optional(),
      sessionId: z.string().min(1),
      url: z.string().url(),
    })
    .strict()
    .optional(),
  kind: z.literal("subagent-input-request"),
  subagentName: z.string().min(1),
  event: z.object({
    ...position,
    requests: z.array(v26RequestSchema).min(1),
    taskId: z.string().optional(),
  }),
});

const signInFields = {
  ...position,
  attemptId: z.string().min(1).optional(),
  name: z.string(),
  principalId: z.string().optional(),
  taskId: z.string().optional(),
};

const authorizationCallbackSchema = z.object({
  callId: z.string().min(1),
  childSessionId: z.string().min(1),
  kind: z.literal("subagent-authorization-event"),
  subagentName: z.string().min(1),
  event: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("approval.candidate"),
      data: z
        .object({
          ...position,
          candidateId: z.string(),
          outcome: z.enum(["pending", "rejected", "failed", "timed-out", "stale"]),
          reason: z.string().optional(),
          requestId: z.string().min(1),
          responderPrincipalId: z.string(),
        })
        .passthrough(),
    }),
    z.object({
      type: z.literal("approval.settled"),
      data: z
        .object({
          ...position,
          outcome: z.enum(["approved", "cancelled"]),
          requestId: z.string().min(1),
          responderPrincipalId: z.string(),
        })
        .passthrough(),
    }),
    z.object({
      type: z.literal("input.resolved"),
      data: z
        .object({
          ...position,
          resolutions: z.array(
            z
              .object({
                kind: z.enum(["question", "session-limit", "tool-approval"]),
                outcome: z.enum([
                  "answered",
                  "approved",
                  "cancelled",
                  "denied",
                  "ignored",
                  "invalid",
                ]),
                requestId: z.string().min(1),
                response: v26ResponseSchema.optional(),
              })
              .passthrough(),
          ),
        })
        .passthrough(),
    }),
    z.object({
      type: z.literal("authorization.required"),
      data: z
        .object({ ...signInFields, description: z.string(), webhookUrl: z.string().optional() })
        .passthrough(),
    }),
    z.object({
      type: z.literal("authorization.completed"),
      data: z
        .object({
          ...signInFields,
          outcome: z.enum(["authorized", "declined", "failed", "timed-out"]),
        })
        .passthrough(),
    }),
  ]),
});

/**
 * The answers a session forwarded to a protocol 2 child that it settles itself, as the child takes
 * them: every answer but an approval's, which the child settles and relays, and but the one
 * `decidedHere` names, which this session already settles its own way, such as Stop on a budget
 * prompt.
 */
export function protocolTwoAnswersSettledOnForward(input: {
  readonly answers: readonly Answer[];
  readonly decidedHere?: string;
  readonly kindOf: (interactionId: string) => InteractionKind | undefined;
}): Answer[] {
  return input.answers.filter(
    ({ interactionId }) =>
      interactionId !== input.decidedHere && input.kindOf(interactionId) !== "approval",
  );
}

/**
 * A protocol 2 input callback as that protocol's own parent reads it, for a parent run from before
 * v27 (the callback route resumes its hook with it as is), or `undefined` when the body is not one.
 */
export function parseProtocolTwoInputCallback(body: unknown): object | undefined {
  const request = inputRequestCallbackSchema.safeParse(body);
  if (request.success) return request.data;
  const authorization = authorizationCallbackSchema.safeParse(body);
  return authorization.success ? authorization.data : undefined;
}

/**
 * Reads a protocol 2 child's input callback as the interaction facts it records, or `undefined`
 * when the body is not one. A callback that records nothing this session mirrors, such as an
 * approval's own settlement, reads as a payload without events.
 */
export function readProtocolTwoInputCallback(
  body: unknown,
): SubagentInteractionHookPayload | undefined {
  const request = inputRequestCallbackSchema.safeParse(body);
  if (request.success) {
    const { data } = request;
    return {
      callId: data.callId,
      childSessionId: data.childSessionId,
      events: data.event.requests.map((entry) => {
        const origin = { interactionId: entry.requestId, sessionId: data.childSessionId };
        return fact("interaction.opened", {
          interactionId: entry.requestId,
          // A budget prompt asks about no call; the others ask about the call that asked.
          origin:
            entry.kind === "session-limit"
              ? origin
              : {
                  ...origin,
                  call: {
                    callId: entry.action.callId,
                    input: entry.action.input,
                    name: entry.action.toolName,
                  },
                },
          request: v26InteractionRequest(entry),
          // The serving session names its own call as the subject.
          subject: { turnId: data.event.turnId },
        });
      }),
      kind: "subagent-interaction",
      route: {
        childContinuationToken: data.childContinuationToken,
        ...(data.childSessionInbox !== undefined && { childSessionInbox: data.childSessionInbox }),
        ...(data.inputSource !== undefined && { inputSource: data.inputSource }),
      },
      subagentName: data.subagentName,
    };
  }
  const authorization = authorizationCallbackSchema.safeParse(body);
  if (!authorization.success) return undefined;
  const { data } = authorization;
  return {
    callId: data.callId,
    childSessionId: data.childSessionId,
    events: authorizationEvents(data.childSessionId, data.event),
    kind: "subagent-interaction",
    subagentName: data.subagentName,
  };
}

type AuthorizationEvent = z.infer<typeof authorizationCallbackSchema>["event"];

function authorizationEvents(
  childSessionId: string,
  event: AuthorizationEvent,
): RelayedInteractionEvent[] {
  switch (event.type) {
    case "approval.candidate": {
      // A candidate is an answer the child received: pending, it stands while the child checks
      // who gave it; otherwise the child turned it away and the request stays open.
      const { outcome, reason, requestId: interactionId } = event.data;
      if (outcome === "pending") return [{ data: { interactionId }, type: "response.admitted" }];
      return [
        {
          data: {
            interactionId,
            outcome: CANDIDATE_OUTCOMES[outcome],
            ...(reason !== undefined && { reason }),
          },
          type: "response.settled",
        },
      ];
    }
    case "approval.settled":
      // The `input.resolved` that follows settles the approval, with the answer that decided it.
      return [];
    case "input.resolved":
      return event.data.resolutions.map((resolution) => {
        const response: { optionId?: string; text?: string } = {};
        if (resolution.response?.optionId !== undefined)
          response.optionId = resolution.response.optionId;
        if (resolution.response?.text !== undefined) response.text = resolution.response.text;
        return fact("interaction.settled", {
          interactionId: resolution.requestId,
          outcome: v26InteractionOutcome(resolution.outcome),
          ...(Object.keys(response).length > 0 && { response }),
        });
      });
    case "authorization.required": {
      const principalId = event.data.principalId;
      const interactionId = signInId(childSessionId, event.data);
      return [
        fact("interaction.opened", {
          ...(principalId !== undefined && { audience: { principalIds: [principalId] } }),
          interactionId,
          origin: { interactionId, sessionId: childSessionId },
          request: v26SignInRequest(event.data),
          subject: { turnId: event.data.turnId },
        }),
      ];
    }
    case "authorization.completed":
      return [
        fact("interaction.settled", {
          interactionId: signInId(childSessionId, event.data),
          outcome: v26SignInOutcome(event.data.outcome),
        }),
      ];
  }
}

const CANDIDATE_OUTCOMES: Record<"rejected" | "failed" | "timed-out" | "stale", ResponseOutcome> = {
  failed: "failed",
  rejected: "refused",
  stale: "withdrawn",
  "timed-out": "expired",
};

/**
 * A sign-in's id: its attempt, or, from a child that names none, what the child's sign-in is for,
 * which its required and completed events both carry.
 */
function signInId(
  childSessionId: string,
  data: { readonly attemptId?: string; readonly name: string; readonly principalId?: string },
): string {
  return (
    data.attemptId ??
    `signin_${childSessionId}_${encodeURIComponent(data.name)}_${data.principalId ?? ""}`
  );
}
