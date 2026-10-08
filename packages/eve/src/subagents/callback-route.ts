import { renameLegacyTaskCallback } from "#execution/legacy-remote-agent/protocol.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { z } from "#compiled/zod/index.js";
import type { RouteContext } from "#public/definitions/channel.js";
import type { RuntimeSubagentChildResult } from "#shared/action-types.js";
import { inputRequestSchema, inputResponseSchema } from "#shared/input.js";
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

const sessionAuthorizationCallbackSchema = z.object({
  callId: z.string().min(1),
  childSessionId: z.string().min(1),
  kind: z.literal("subagent-authorization-event"),
  subagentName: z.string().min(1),
  event: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("approval.candidate"),
      data: z
        .object({
          candidateId: z.string(),
          outcome: z.enum(["pending", "rejected", "failed", "timed-out", "stale"]),
          requestId: z.string(),
          responderPrincipalId: z.string(),
          reason: z.string().optional(),
          sequence: z.number(),
          stepIndex: z.number(),
          turnId: z.string(),
        })
        .passthrough(),
    }),
    z.object({
      type: z.literal("approval.settled"),
      data: z
        .object({
          outcome: z.enum(["approved", "cancelled"]),
          requestId: z.string(),
          responderPrincipalId: z.string(),
          sequence: z.number(),
          stepIndex: z.number(),
          turnId: z.string(),
        })
        .passthrough(),
    }),
    z.object({
      type: z.literal("input.resolved"),
      data: z
        .object({
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
                requestId: z.string(),
                response: inputResponseSchema.optional(),
              })
              .passthrough(),
          ),
          sequence: z.number(),
          stepIndex: z.number(),
          turnId: z.string(),
        })
        .passthrough(),
    }),
    z.object({
      type: z.literal("authorization.required"),
      data: z
        .object({
          description: z.string(),
          name: z.string(),
          sequence: z.number(),
          stepIndex: z.number(),
          turnId: z.string(),
          webhookUrl: z.string().optional(),
          attemptId: z.string().optional(),
          taskId: z.string().optional(),
          principalId: z.string().optional(),
        })
        .passthrough(),
    }),
    z.object({
      type: z.literal("authorization.completed"),
      data: z
        .object({
          name: z.string(),
          outcome: z.enum(["authorized", "declined", "failed", "timed-out"]),
          sequence: z.number(),
          stepIndex: z.number(),
          turnId: z.string(),
          attemptId: z.string().optional(),
          taskId: z.string().optional(),
          principalId: z.string().optional(),
        })
        .passthrough(),
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
    body = renameLegacyTaskCallback(await request.json());
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
    await resumeHook(
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
