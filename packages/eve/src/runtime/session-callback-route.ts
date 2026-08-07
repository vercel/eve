import { resumeHook } from "#internal/workflow/runtime.js";
import { REMOTE_AGENT_FAILED } from "#harness/agent-handle-errors.js";
import { EVE_CALLBACK_ROUTE_PATTERN } from "#protocol/routes.js";
import type { ChannelMethod, RouteContext } from "#public/definitions/channel.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";
import type { RuntimeSubagentChildResult } from "#runtime/actions/types.js";
import { agentTurnOutcomeSchema, type AgentTurnOutcome } from "#shared/agent-turn-outcome.js";
import type { JsonValue } from "#shared/json.js";
import { isInputRequest } from "#runtime/input/types.js";
import { tokenUsageSchema, type TokenUsage } from "#shared/token-usage.js";
import type {
  TaskInboundAuthorizationEvent,
  TaskInboundInputRequest,
  TaskInboundTurnStarted,
} from "#tasks/types.js";

export const HTTP_SESSION_CALLBACK_CHANNEL_NAME_PREFIX = "eve/v1/callback";

const HANDLED_METHODS: readonly ChannelMethod[] = ["POST"];

const ZERO_TOKEN_USAGE: TokenUsage = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
};

/**
 * Wire payload of the child→parent callback route. Possession of the
 * callback token is the authorization to settle; results bind to the
 * pending call by callId. `sessionId` is informational (tracing and
 * diagnostics) and never verified — new senders emit it, older eve
 * deployments may omit it.
 */
type SessionCallbackPayload =
  | {
      readonly callId: string;
      readonly childContinuationToken: string;
      readonly childSessionId: string;
      readonly event: TaskInboundInputRequest["event"];
      readonly kind: "task.input-requested";
      readonly subagentName: string;
      readonly taskId: string;
    }
  | {
      readonly callId: string;
      readonly childContinuationToken: string;
      readonly childSessionId: string;
      readonly event: TaskInboundAuthorizationEvent["event"];
      readonly kind: "task.authorization";
      readonly subagentName: string;
      readonly taskId: string;
    }
  | {
      readonly callId: string;
      readonly kind: "turn.started";
      readonly sessionId: string;
      readonly subagentName: string;
      readonly taskId: string;
      readonly turnId: string;
    }
  | {
      readonly callId: string;
      readonly kind: "session.completed";
      readonly output: JsonValue;
      readonly sessionId?: string;
      readonly subagentName: string;
      readonly usage?: TokenUsage;
    }
  | {
      readonly callId: string;
      /** Absent on callbacks from older eve deployments. */
      readonly error?: JsonValue;
      readonly kind: "session.failed";
      readonly sessionId?: string;
      readonly subagentName: string;
      readonly usage?: TokenUsage;
    }
  | {
      readonly callId: string;
      readonly kind: "turn.completed";
      readonly outcome: AgentTurnOutcome;
      readonly output: JsonValue;
      readonly sessionId?: string;
      readonly subagentName: string;
    }
  | {
      readonly callId: string;
      readonly error: JsonValue;
      readonly kind: "turn.failed";
      readonly outcome: AgentTurnOutcome;
      readonly sessionId?: string;
      readonly subagentName: string;
    };

export function getSessionCallbackChannelDefinitions(): readonly ResolvedChannelDefinition[] {
  return HANDLED_METHODS.map((method) => buildCallbackChannelDefinition(method));
}

export function getSessionCallbackChannelNames(): ReadonlySet<string> {
  return new Set(HANDLED_METHODS.map(channelNameForMethod));
}

function buildCallbackChannelDefinition(method: ChannelMethod): ResolvedChannelDefinition {
  const name = channelNameForMethod(method);
  return {
    name,
    method,
    urlPath: EVE_CALLBACK_ROUTE_PATTERN,
    fetch: handleSessionCallbackRequest,
    logicalPath: `framework://channels/${name}`,
    sourceId: `eve:framework:session-callback-${method.toLowerCase()}`,
    sourceKind: "module",
  };
}

function channelNameForMethod(method: ChannelMethod): string {
  return `${HTTP_SESSION_CALLBACK_CHANNEL_NAME_PREFIX}/${method.toLowerCase()}`;
}

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

  const taskEvent = projectTaskEvent(body);
  if (taskEvent instanceof Response) return taskEvent;
  if (taskEvent !== undefined) {
    try {
      await resumeHook(token, taskEvent);
    } catch {
      return Response.json({ error: "Session callback not pending.", ok: false }, { status: 404 });
    }
    return Response.json({ ok: true }, { status: 202 });
  }

  const started = projectTaskTurnStarted(body);
  if (started instanceof Response) return started;
  if (started !== undefined) {
    try {
      await resumeHook(token, started);
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
    await resumeHook(token, {
      kind: "runtime-action-result",
      results: [result],
    });
  } catch {
    return Response.json({ error: "Session callback not pending.", ok: false }, { status: 404 });
  }

  return Response.json({ ok: true }, { status: 202 });
}

function projectTaskEvent(
  value: unknown,
): TaskInboundInputRequest | TaskInboundAuthorizationEvent | Response | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const payload = value as Partial<SessionCallbackPayload>;
  if (payload.kind !== "task.input-requested" && payload.kind !== "task.authorization") {
    return undefined;
  }
  if (
    typeof payload.callId !== "string" ||
    typeof payload.childContinuationToken !== "string" ||
    typeof payload.childSessionId !== "string" ||
    typeof payload.subagentName !== "string" ||
    typeof payload.taskId !== "string" ||
    payload.event === undefined
  ) {
    return Response.json({ error: "Invalid task event callback.", ok: false }, { status: 400 });
  }
  if (payload.kind === "task.input-requested") {
    if (!isTaskInputEvent(payload.event)) {
      return Response.json({ error: "Invalid task input callback event.", ok: false }, { status: 400 });
    }
    return {
      callId: payload.callId,
      childContinuationToken: payload.childContinuationToken,
      childSessionId: payload.childSessionId,
      event: payload.event as TaskInboundInputRequest["event"],
      kind: "subagent-input-request",
      subagentName: payload.subagentName,
    };
  }
  if (!isTaskAuthorizationEvent(payload.event)) {
    return Response.json(
      { error: "Invalid task authorization callback event.", ok: false },
      { status: 400 },
    );
  }
  return {
    callId: payload.callId,
    childSessionId: payload.childSessionId,
    event: payload.event as TaskInboundAuthorizationEvent["event"],
    kind: "subagent-authorization-event",
    subagentName: payload.subagentName,
  };
}

function isTaskInputEvent(value: unknown): value is TaskInboundInputRequest["event"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const requests = Reflect.get(value, "requests");
  return (
    Array.isArray(requests) &&
    requests.length > 0 &&
    requests.every(isInputRequest) &&
    isEventCoordinate(value, "sequence") &&
    isEventCoordinate(value, "stepIndex") &&
    typeof Reflect.get(value, "turnId") === "string"
  );
}

function isTaskAuthorizationEvent(
  value: unknown,
): value is TaskInboundAuthorizationEvent["event"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const type = Reflect.get(value, "type");
  const data = Reflect.get(value, "data");
  if (
    (type !== "authorization.required" && type !== "authorization.completed") ||
    data === null ||
    typeof data !== "object" ||
    Array.isArray(data)
  ) {
    return false;
  }
  return (
    typeof Reflect.get(data, "name") === "string" &&
    typeof Reflect.get(data, "turnId") === "string" &&
    isEventCoordinate(data, "sequence") &&
    isEventCoordinate(data, "stepIndex") &&
    (type === "authorization.required"
      ? typeof Reflect.get(data, "description") === "string"
      : typeof Reflect.get(data, "outcome") === "string")
  );
}

function isEventCoordinate(value: object, key: string): boolean {
  const coordinate = Reflect.get(value, key);
  return typeof coordinate === "number" && Number.isInteger(coordinate) && coordinate >= 0;
}

function projectTaskTurnStarted(value: unknown): TaskInboundTurnStarted | Response | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const payload = value as Partial<SessionCallbackPayload>;
  if (payload.kind !== "turn.started") return undefined;
  if (
    typeof payload.sessionId !== "string" ||
    payload.sessionId.length === 0 ||
    typeof payload.taskId !== "string" ||
    payload.taskId.length === 0 ||
    typeof payload.turnId !== "string" ||
    payload.turnId.length === 0
  ) {
    return Response.json(
      { error: "Invalid task turn-start callback.", ok: false },
      { status: 400 },
    );
  }
  return {
    childSessionId: payload.sessionId,
    childTurnId: payload.turnId,
    kind: "task-child-turn-started",
    taskId: payload.taskId,
  };
}

function projectSessionCallbackResult(value: unknown): RuntimeSubagentChildResult | Response {
  if (value === null || typeof value !== "object") {
    return Response.json({ error: "Expected a JSON object.", ok: false }, { status: 400 });
  }

  const payload = value as Partial<SessionCallbackPayload>;
  if (typeof payload.callId !== "string" || payload.callId.length === 0) {
    return Response.json({ error: "Missing callback callId.", ok: false }, { status: 400 });
  }
  if (typeof payload.subagentName !== "string" || payload.subagentName.length === 0) {
    return Response.json({ error: "Missing callback subagentName.", ok: false }, { status: 400 });
  }
  // Task-session terminal callbacks carry no outcome envelope on the wire;
  // this boundary synthesizes the terminal verdict (a task session always
  // ends with its result) so the parent settles from an explicit outcome.
  if (payload.kind === "session.completed") {
    const output = payload.output ?? "";
    const usage = parseCallbackUsage((payload as { usage?: unknown }).usage);
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
    const usage = parseCallbackUsage((payload as { usage?: unknown }).usage);
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
    const outcome = parseCallbackOutcome((payload as { outcome?: unknown }).outcome);
    if (outcome instanceof Response) {
      return outcome;
    }
    const result: RuntimeSubagentChildResult = {
      callId: payload.callId,
      kind: "subagent-result",
      origin: "child",
      outcome,
      output: payload.output ?? "",
      subagentName: payload.subagentName,
      // Per-result usage projection (usage spans); the parent folds
      // `outcome.usageDelta`, never this field, when an outcome is present.
      usage: outcome.usageDelta,
    };
    return result;
  }

  if (payload.kind === "turn.failed") {
    if (payload.error === undefined) {
      return Response.json({ error: "Missing callback error.", ok: false }, { status: 400 });
    }
    const outcome = parseCallbackOutcome((payload as { outcome?: unknown }).outcome);
    if (outcome instanceof Response) {
      return outcome;
    }
    return {
      callId: payload.callId,
      isError: true,
      kind: "subagent-result",
      origin: "child",
      outcome,
      output: payload.error,
      subagentName: payload.subagentName,
    };
  }

  return Response.json({ error: "Unsupported callback kind.", ok: false }, { status: 400 });
}

/**
 * Turn callbacks must carry the explicit {@link AgentTurnOutcome} envelope:
 * the receiving parent settles the child's handle from `outcome.kind`, so
 * a turn callback that cannot state its lifecycle is rejected rather than
 * guessed at (pre-1.0: no wire compatibility shims).
 */
function parseCallbackOutcome(value: unknown): AgentTurnOutcome | Response {
  const parsed = agentTurnOutcomeSchema.safeParse(value);
  if (!parsed.success) {
    return Response.json(
      { error: "Missing or invalid callback outcome.", ok: false },
      { status: 400 },
    );
  }
  return parsed.data;
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
  const parsed = tokenUsageSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
