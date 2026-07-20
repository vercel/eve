import { resumeHook } from "#internal/workflow/runtime.js";
import { EVE_CALLBACK_ROUTE_PATTERN } from "#protocol/routes.js";
import type { ChannelMethod, RouteContext } from "#public/definitions/channel.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";
import type { RuntimeSubagentResultActionResult } from "#runtime/actions/types.js";
import type { JsonValue } from "#shared/json.js";
import { tokenUsageSchema, type TokenUsage } from "#shared/token-usage.js";

export const HTTP_SESSION_CALLBACK_CHANNEL_NAME_PREFIX = "eve/v1/callback";

const HANDLED_METHODS: readonly ChannelMethod[] = ["POST"];

type SessionTerminalCallbackPayload =
  | {
      readonly callId: string;
      readonly kind: "session.completed";
      readonly output: string;
      readonly sessionId: string;
      readonly subagentName: string;
      readonly usage?: TokenUsage;
    }
  | {
      readonly callId: string;
      readonly error: JsonValue;
      readonly kind: "session.failed";
      readonly sessionId: string;
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

function projectSessionCallbackResult(
  value: unknown,
): RuntimeSubagentResultActionResult | Response {
  if (value === null || typeof value !== "object") {
    return Response.json({ error: "Expected a JSON object.", ok: false }, { status: 400 });
  }

  const payload = value as Partial<SessionTerminalCallbackPayload>;
  if (typeof payload.callId !== "string" || payload.callId.length === 0) {
    return Response.json({ error: "Missing callback callId.", ok: false }, { status: 400 });
  }
  if (typeof payload.subagentName !== "string" || payload.subagentName.length === 0) {
    return Response.json({ error: "Missing callback subagentName.", ok: false }, { status: 400 });
  }

  if (payload.kind === "session.completed") {
    const base: RuntimeSubagentResultActionResult = {
      callId: payload.callId,
      kind: "subagent-result",
      output: payload.output ?? "",
      subagentName: payload.subagentName,
    };
    const usage = parseCallbackUsage((payload as { usage?: unknown }).usage);
    return usage === undefined ? base : { ...base, usage };
  }

  if (payload.kind === "session.failed") {
    return {
      callId: payload.callId,
      isError: true,
      kind: "subagent-result",
      output:
        payload.error === undefined
          ? {
              code: "REMOTE_AGENT_FAILED",
              message: "Remote agent failed.",
            }
          : payload.error,
      subagentName: payload.subagentName,
    };
  }

  return Response.json({ error: "Unsupported callback kind.", ok: false }, { status: 400 });
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
