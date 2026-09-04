import { sendSubagentReply } from "#subagents/reply.js";
import { readCallbackCapability } from "#subagents/callback-capability.js";
import { z } from "#compiled/zod/index.js";
import { REMOTE_AGENT_FAILED } from "#subagents/agent-handle-errors.js";
import type { RouteContext } from "#public/definitions/channel.js";
import type {
  SubagentAuthorizationEvent,
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import type { RuntimeSubagentChildResult } from "#shared/action-types.js";
import { agentTurnOutcomeWithCostSchema } from "#shared/agent-turn-outcome.js";
import { jsonValueSchema } from "#shared/json-schemas.js";
import type { JsonValue } from "#shared/json.js";
import { isInputRequest } from "#shared/input.js";
import { tokenUsageWithCostSchema, type TokenUsage } from "#shared/token-usage.js";
import type { TaskInboundUpdate } from "#tasks/types.js";
import { readTaskIdFromInboxToken } from "#tasks/task-inbox-token.js";

const ZERO_TOKEN_USAGE: TokenUsage = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
};

// Wire schemas of the child→parent callback route. Possession of the
// callback token is the authorization to settle; results bind to the
// pending call by callId. `sessionId` is informational (tracing and
// diagnostics) and never verified — new senders emit it, older eve
// deployments may omit it.

const eventCoordinateSchema = z.number().int().nonnegative();

const authorizationChallengeSchema = z.looseObject({
  displayName: z.string().optional(),
  expiresAt: z.string().optional(),
  instructions: z.string().optional(),
  url: z.string().optional(),
  userCode: z.string().optional(),
});

/**
 * Event payloads validate the fields the parent consumes and pass any
 * remaining keys through unchanged (loose objects): the parent re-emits
 * the event, so a newer child extending an event is never rejected here.
 */
const taskInputEventSchema = z.looseObject({
  requests: z.array(jsonValueSchema.refine(isInputRequest)).min(1),
  sequence: eventCoordinateSchema,
  stepIndex: eventCoordinateSchema,
  turnId: z.string(),
});

const taskAuthorizationEventSchema: z.ZodType<SubagentAuthorizationEvent> = z.discriminatedUnion(
  "type",
  [
    z.looseObject({
      data: z.looseObject({
        attemptId: z.string().optional(),
        authorization: authorizationChallengeSchema.optional(),
        description: z.string(),
        name: z.string(),
        sequence: eventCoordinateSchema,
        stepIndex: eventCoordinateSchema,
        turnId: z.string(),
        webhookUrl: z.string().optional(),
      }),
      type: z.literal("authorization.required"),
    }),
    z.looseObject({
      data: z.looseObject({
        attemptId: z.string().optional(),
        authorization: authorizationChallengeSchema.optional(),
        name: z.string(),
        outcome: z.enum(["authorized", "declined", "failed", "timed-out"]),
        reason: z.string().optional(),
        sequence: eventCoordinateSchema,
        stepIndex: eventCoordinateSchema,
        turnId: z.string(),
      }),
      type: z.literal("authorization.completed"),
    }),
  ],
);

const taskEventCallbackSchema = z.discriminatedUnion("kind", [
  z.object({
    callId: z.string(),
    childContinuationToken: z.string(),
    childSessionId: z.string(),
    event: taskInputEventSchema,
    kind: z.literal("task.input-requested"),
    subagentName: z.string(),
    taskId: z.string(),
  }),
  z.object({
    callId: z.string(),
    childContinuationToken: z.string(),
    childSessionId: z.string(),
    event: taskAuthorizationEventSchema,
    kind: z.literal("task.authorization"),
    subagentName: z.string(),
    taskId: z.string(),
  }),
]);

const taskUpdateCallbackSchema = z.object({
  callId: z.string().min(1),
  kind: z.literal("task.update"),
  message: z.string().min(1),
  taskId: z.string().min(1),
  updateEpoch: z.string().min(1),
  updateIndex: eventCoordinateSchema,
});

/**
 * Turn callbacks must carry the explicit `AgentTurnOutcome` envelope:
 * the receiving parent settles the child's handle from `outcome.kind`, so
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

  const target = readCallbackCapability(token);
  if (target === undefined) {
    return Response.json({ error: "Invalid callback capability.", ok: false }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await readCallbackBody(request);
  } catch {
    return Response.json({ error: "Invalid JSON body.", ok: false }, { status: 400 });
  }

  if (
    body === null ||
    typeof body !== "object" ||
    Reflect.get(body, "callId") !== target.requestId
  ) {
    return Response.json({ error: "Callback invocation mismatch.", ok: false }, { status: 403 });
  }

  const taskEvent = projectTaskEvent(body, target.address.token);
  if (taskEvent instanceof Response) return taskEvent;
  if (taskEvent !== undefined) {
    try {
      if ((await sendSubagentReply(target, taskEvent)) === "gone") throw new Error("Owner ended.");
    } catch {
      return Response.json({ error: "Session callback not pending.", ok: false }, { status: 404 });
    }
    return Response.json({ ok: true }, { status: 202 });
  }

  const update = projectTaskUpdate(body, target.address.token);
  if (update instanceof Response) return update;
  if (update !== undefined) {
    try {
      if ((await sendSubagentReply(target, update)) === "gone") throw new Error("Owner ended.");
    } catch {
      return Response.json({ error: "Session callback not pending.", ok: false }, { status: 404 });
    }
    return Response.json({ ok: true }, { status: 202 });
  }

  const result = projectSessionCallbackResult(body);
  if (result instanceof Response) {
    return result;
  }

  try {
    if (
      (await sendSubagentReply(target, {
        kind: "runtime-action-result",
        results: [result],
      })) === "gone"
    )
      throw new Error("Owner ended.");
  } catch {
    return Response.json({ error: "Session callback not pending.", ok: false }, { status: 404 });
  }

  return Response.json({ ok: true }, { status: 202 });
}

function callbackKind(value: unknown): unknown {
  if (value === null || typeof value !== "object") return undefined;
  return Reflect.get(value, "kind");
}

function projectTaskEvent(
  value: unknown,
  token: string,
): SubagentAuthorizationEventHookPayload | SubagentInputRequestHookPayload | Response | undefined {
  const kind = callbackKind(value);
  if (kind !== "task.input-requested" && kind !== "task.authorization") return undefined;
  const parsed = taskEventCallbackSchema.safeParse(value);
  if (!parsed.success) {
    return Response.json({ error: "Invalid task event callback.", ok: false }, { status: 400 });
  }
  const payload = parsed.data;
  if (readTaskIdFromInboxToken(token) !== undefined) {
    const tokenRejection = rejectMismatchedTaskToken(token, payload.taskId);
    if (tokenRejection !== undefined) return tokenRejection;
    return Response.json(
      { error: "Direct subagent task events are no longer accepted.", ok: false },
      { status: 410 },
    );
  }
  return payload.kind === "task.input-requested"
    ? {
        callId: payload.callId,
        childContinuationToken: payload.childContinuationToken,
        childSessionId: payload.childSessionId,
        event: payload.event,
        kind: "subagent-input-request",
        subagentName: payload.subagentName,
      }
    : {
        callId: payload.callId,
        childSessionId: payload.childSessionId,
        event: payload.event,
        kind: "subagent-authorization-event",
        subagentName: payload.subagentName,
      };
}

function projectTaskUpdate(
  value: unknown,
  token: string,
): TaskInboundUpdate | Response | undefined {
  if (callbackKind(value) !== "task.update") return undefined;
  const parsed = taskUpdateCallbackSchema.safeParse(value);
  if (!parsed.success) {
    return Response.json({ error: "Invalid task update callback.", ok: false }, { status: 400 });
  }
  if (readTaskIdFromInboxToken(token) !== undefined) {
    const tokenRejection = rejectMismatchedTaskToken(token, parsed.data.taskId);
    if (tokenRejection !== undefined) return tokenRejection;
  }
  return {
    callId: parsed.data.callId,
    kind: "task-update",
    message: parsed.data.message,
    updateEpoch: parsed.data.updateEpoch,
    updateIndex: parsed.data.updateIndex,
  };
}

function rejectMismatchedTaskToken(token: string, taskId: string): Response | undefined {
  return readTaskIdFromInboxToken(token) === taskId
    ? undefined
    : Response.json({ error: "Task callback token mismatch.", ok: false }, { status: 403 });
}

function projectSessionCallbackResult(value: unknown): RuntimeSubagentChildResult | Response {
  if (value === null || typeof value !== "object") {
    return Response.json({ error: "Expected a JSON object.", ok: false }, { status: 400 });
  }

  const kind = callbackKind(value);
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

async function readCallbackBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (reader === undefined) throw new Error("Missing callback body.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 1024 * 1024) {
        await reader.cancel();
        throw new Error("Callback body exceeds its size limit.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
