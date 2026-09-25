import { resumeHook } from "#internal/workflow/runtime.js";
import { z } from "#compiled/zod/index.js";
import type { RouteContext } from "#public/definitions/channel.js";
import type { RuntimeSubagentChildResult } from "#shared/action-types.js";
import { agentTurnOutcomeWithCostSchema } from "#shared/agent-turn-outcome.js";
import { jsonValueSchema } from "#shared/json-schemas.js";

// Wire schemas of the child→parent callback route. Possession of the
// callback token is the authorization to settle; results bind to the
// pending call by callId. `sessionId` is informational (tracing and
// diagnostics) and never verified — new senders emit it, older eve
// deployments may omit it.

/**
 * Turn callbacks must carry the explicit `AgentTurnOutcome` envelope:
 * the receiving parent settles the child's handle from `outcome.kind`, so
 * a turn callback that cannot state its lifecycle is rejected rather than
 * guessed at (pre-1.0: no wire compatibility shims).
 */
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

  const result = projectSessionCallbackResult(body);
  if (result instanceof Response) {
    return result;
  }

  try {
    await resumeHook(token, {
      kind: "runtime-action-result",
      results: [result],
    });
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
      // Per-result usage projection (usage spans); the parent folds
      // `outcome.usageDelta`, never this field, when an outcome is present.
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
