import { resumeHook } from "#internal/workflow/runtime.js";
import { z } from "#compiled/zod/index.js";
import { REMOTE_AGENT_FAILED } from "#subagents/agent-handle-errors.js";
import type { RuntimeActionResultHookPayload } from "#channel/types.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import type { RouteContext } from "#public/definitions/channel.js";
import { TASK_CALLBACK_ALIAS_PREFIX } from "#tasks/state.js";
import type { RuntimeSubagentChildResult } from "#shared/action-types.js";
import { agentTurnOutcomeWithCostSchema } from "#shared/agent-turn-outcome.js";
import { jsonValueSchema } from "#shared/json-schemas.js";
import type { JsonValue } from "#shared/json.js";
import { tokenUsageWithCostSchema, type TokenUsage } from "#shared/token-usage.js";

const ZERO_TOKEN_USAGE: TokenUsage = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
};

// Wire schemas of the child→parent callback route. Possession of the owner's
// callback alias is the authorization to report; results bind to a remote
// task by callId and agent name. The self-reported `sessionId` narrows which
// remote task a result may settle; older eve deployments may omit it.

/**
 * Turn callbacks must carry the explicit `AgentTurnOutcome` envelope:
 * the receiving owner settles the task record from `outcome.kind`, so
 * a turn callback that cannot state its lifecycle is rejected rather than
 * guessed at (pre-1.0: no wire compatibility shims). `usage` stays
 * unvalidated here — {@link parseCallbackUsage} drops it, never rejects
 * it, when malformed.
 */
const sessionResultCallbackSchema = z.discriminatedUnion("kind", [
  z.object({
    callId: z.string().min(1),
    kind: z.literal("session.completed"),
    output: jsonValueSchema.optional(),
    subagentName: z.string().min(1),
    usage: z.unknown().optional(),
  }),
  z.object({
    callId: z.string().min(1),
    /** Absent on callbacks from older eve deployments. */
    error: jsonValueSchema.optional(),
    kind: z.literal("session.failed"),
    subagentName: z.string().min(1),
    usage: z.unknown().optional(),
  }),
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
  // Only an owner's unguessable callback alias is reachable here; every
  // other session address is derivable from a session ID.
  if (!token.startsWith(sessionInboxHookToken(TASK_CALLBACK_ALIAS_PREFIX))) {
    return Response.json({ error: "Session callback not pending.", ok: false }, { status: 404 });
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
  const sessionId = Reflect.get(body as object, "sessionId");
  const source: { kind: "remote"; sessionId?: string } = { kind: "remote" };
  if (typeof sessionId === "string" && sessionId.length > 0) source.sessionId = sessionId;
  const payload: RuntimeActionResultHookPayload = {
    kind: "runtime-action-result",
    results: [result],
    source,
  };

  try {
    await resumeHook(token, payload);
  } catch {
    return Response.json({ error: "Session callback not pending.", ok: false }, { status: 404 });
  }

  return Response.json({ ok: true }, { status: 202 });
}

function projectSessionCallbackResult(value: unknown): RuntimeSubagentChildResult | Response {
  if (value === null || typeof value !== "object") {
    return Response.json({ error: "Expected a JSON object.", ok: false }, { status: 400 });
  }

  const kind = Reflect.get(value, "kind");
  if (
    kind !== "session.completed" &&
    kind !== "session.failed" &&
    kind !== "turn.completed" &&
    kind !== "turn.failed"
  ) {
    return Response.json({ error: "Unsupported callback kind.", ok: false }, { status: 400 });
  }

  const parsed = sessionResultCallbackSchema.safeParse(value);
  if (!parsed.success) {
    return Response.json({ error: "Invalid session result callback.", ok: false }, { status: 400 });
  }
  const payload = parsed.data;

  // Task-session terminal callbacks carry no outcome envelope on the wire;
  // this boundary synthesizes the terminal verdict (a task session always
  // ends with its result) so the parent settles from an explicit outcome.
  if (payload.kind === "session.completed") {
    const output = payload.output ?? "";
    const usage = parseCallbackUsage(payload.usage);
    const base: RuntimeSubagentChildResult = {
      callId: payload.callId,
      kind: "subagent-result",
      origin: "child",
      outcome: {
        kind: "terminal",
        result: { kind: "succeeded", output },
        usageDelta: usage ?? ZERO_TOKEN_USAGE,
      },
      output,
      subagentName: payload.subagentName,
    };
    return usage === undefined ? base : { ...base, usage };
  }

  if (payload.kind === "session.failed") {
    const error: JsonValue =
      payload.error === undefined
        ? {
            code: REMOTE_AGENT_FAILED,
            message: "Remote agent failed.",
          }
        : payload.error;
    const usage = parseCallbackUsage(payload.usage);
    return {
      callId: payload.callId,
      isError: true,
      kind: "subagent-result",
      origin: "child",
      outcome: {
        kind: "terminal",
        result: { error, kind: "failed" },
        usageDelta: usage ?? ZERO_TOKEN_USAGE,
      },
      output: error,
      subagentName: payload.subagentName,
    };
  }

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

/**
 * TokenUsage arrives from a remote callee that may run a different eve version,
 * so it is validated independently and dropped — never rejected — when
 * malformed. The rest of the callback still resumes the parent.
 */
function parseCallbackUsage(value: unknown): TokenUsage | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = tokenUsageWithCostSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
