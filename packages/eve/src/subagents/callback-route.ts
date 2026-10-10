import { resumeRunnableHook } from "#execution/session-inbox/owner.js";
import { z } from "#compiled/zod/index.js";
import type { RouteContext } from "#public/definitions/channel.js";
import type { RuntimeSubagentChildResult } from "#shared/action-types.js";
import { inputRequestSchema } from "#shared/input.js";
import { RESPONSE_OUTCOMES } from "#protocol/session-events/catalog.js";
import { interactionSchemas } from "#protocol/session-events/families/interaction.js";
import { agentTurnOutcomeWithCostSchema } from "#shared/agent-turn-outcome.js";
import { jsonValueSchema } from "#shared/json-schemas.js";

// The callback token grants access to the pending turn. Validate remote input
// before handing it to the parent; the child session ID is not authority.
const sessionInputCallbackSchema = z.object({
  callId: z.string().min(1),
  childContinuationToken: z.string().min(1),
  childSessionId: z.string().min(1),
  childSessionInbox: z
    .object({ sessionId: z.string().min(1) })
    .strict()
    .optional(),
  inputSource: z.string().min(1).optional(),
  remote: z
    .object({
      name: z.string().min(1),
      url: z.string().url(),
      forwardPrincipal: z.boolean().optional(),
      sessionId: z.string().min(1),
      resolverId: z.string().min(1).optional(),
    })
    .strict()
    .optional(),
  kind: z.literal("subagent-input-request"),
  subagentName: z.string().min(1),
  event: z.object({
    requests: z.array(inputRequestSchema).min(1),
    sequence: z.number(),
    stepIndex: z.number(),
    taskId: z.string().optional(),
    turnId: z.string(),
  }),
});

// A child's interaction changes keep its own ids; the parent mirrors them. Unknown fields are
// dropped, so a newer child's additions don't refuse the relay.
const sessionAuthorizationCallbackSchema = z.object({
  callId: z.string().min(1),
  childSessionId: z.string().min(1),
  kind: z.literal("subagent-authorization-event"),
  subagentName: z.string().min(1),
  event: z.discriminatedUnion("type", [
    interactionSchemas["interaction.opened"],
    interactionSchemas["interaction.settled"],
    z.object({
      type: z.literal("response.admitted"),
      data: z.object({ deliveryId: z.string().optional(), interactionId: z.string() }),
    }),
    z.object({
      type: z.literal("response.settled"),
      data: z.object({
        deliveryId: z.string().optional(),
        interactionId: z.string(),
        outcome: z.enum(RESPONSE_OUTCOMES),
        reason: z.string().optional(),
      }),
    }),
  ]),
});

/** A settled remote turn must state its outcome; callers do not infer its lifecycle. */
const sessionResultCallbackSchema = z.discriminatedUnion("kind", [
  z.object({
    callId: z.string().min(1),
    kind: z.literal("turn.completed"),
    outcome: agentTurnOutcomeWithCostSchema,
    output: jsonValueSchema.optional(),
    subagentName: z.string().min(1),
  }),
  z.object({
    callId: z.string().min(1),
    error: jsonValueSchema,
    kind: z.literal("turn.failed"),
    outcome: agentTurnOutcomeWithCostSchema,
    subagentName: z.string().min(1),
  }),
]);

export async function handleSessionCallbackRequest(
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  const token = ctx.params.token;
  if (typeof token !== "string" || token.length === 0) {
    return Response.json({ error: "Missing callback token.", ok: false }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body.", ok: false }, { status: 400 });
  }

  const kind = callbackKind(body);
  const forwarded =
    kind === "subagent-input-request"
      ? sessionInputCallbackSchema.safeParse(body)
      : kind === "subagent-authorization-event"
        ? sessionAuthorizationCallbackSchema.safeParse(body)
        : undefined;
  if (forwarded !== undefined && !forwarded.success) {
    return Response.json({ error: "Invalid session input callback.", ok: false }, { status: 400 });
  }
  const result = forwarded === undefined ? projectSessionCallbackResult(body) : undefined;
  if (result instanceof Response) return result;

  try {
    await resumeRunnableHook(
      token,
      forwarded?.success ? forwarded.data : { kind: "runtime-action-result", results: [result] },
    );
  } catch {
    return Response.json({ error: "Session callback not pending.", ok: false }, { status: 404 });
  }

  return Response.json({ ok: true }, { status: 202 });
}

function callbackKind(value: unknown): unknown {
  if (value === null || typeof value !== "object") return undefined;
  return Reflect.get(value, "kind");
}

function projectSessionCallbackResult(value: unknown): RuntimeSubagentChildResult | Response {
  if (value === null || typeof value !== "object") {
    return Response.json({ error: "Expected a JSON object.", ok: false }, { status: 400 });
  }

  const kind = callbackKind(value);
  if (kind !== "turn.completed" && kind !== "turn.failed") {
    return Response.json({ error: "Unsupported callback kind.", ok: false }, { status: 400 });
  }

  const parsed = sessionResultCallbackSchema.safeParse(value);
  if (!parsed.success) {
    return Response.json({ error: "Invalid session result callback.", ok: false }, { status: 400 });
  }
  const payload = parsed.data;

  if (payload.kind === "turn.completed") {
    return {
      callId: payload.callId,
      kind: "subagent-result",
      origin: "child",
      outcome: payload.outcome,
      output: payload.output ?? "",
      subagentName: payload.subagentName,
      // Per-result usage projection (usage spans); the run that opened the
      // child tallies `outcome.usageDelta`, never this field, when present.
      usage: payload.outcome.usageDelta,
    };
  }

  return {
    callId: payload.callId,
    isError: true,
    kind: "subagent-result",
    origin: "child",
    outcome: payload.outcome,
    output: payload.error,
    subagentName: payload.subagentName,
  };
}
