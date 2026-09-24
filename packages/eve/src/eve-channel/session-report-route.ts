import { createLogger, logError } from "#internal/logging.js";
import type { RouteHandlerArgs } from "#public/definitions/channel.js";
import { routeAuth } from "#public/channels/auth.js";
import { readLatestTaskReport } from "#subagents/task-reports.js";
import { TASK_PROTOCOL_RESPONSE_FIELD } from "#eve-channel/task-protocol-request.js";
import type { EveChannelInput } from "#eve-channel/types.js";

const log = createLogger("eve.channel.session-report");

/**
 * Returns the latest result a delegated session reported to its caller for
 * one call. A calling eve deployment reads it once, at the call's deadline,
 * to recover a result whose callback never arrived. Uses the same channel
 * auth as the session's stream route.
 */
export async function handleSessionReportRequest(
  input: Pick<EveChannelInput, "auth">,
  req: Request,
  args: RouteHandlerArgs,
): Promise<Response> {
  const authResult = await routeAuth(req, input.auth);
  if (authResult instanceof Response) return authResult;
  const { callId, sessionId } = args.params;
  if (!sessionId || !callId) {
    return Response.json({ error: "Missing session or call id.", ok: false }, { status: 400 });
  }
  try {
    const report = await readLatestTaskReport({ callId, sessionId });
    return Response.json(
      { ok: true, report: report ?? null, ...TASK_PROTOCOL_RESPONSE_FIELD },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    logError(log, "session report read failed", error, { sessionId });
    return Response.json({ error: "Session not found.", ok: false }, { status: 404 });
  }
}
