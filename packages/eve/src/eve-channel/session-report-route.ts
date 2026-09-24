import { createLogger, logError } from "#internal/logging.js";
import { EVE_CALLBACK_TOKEN_HEADER } from "#protocol/message.js";
import type { RouteHandlerArgs } from "#public/definitions/channel.js";
import { routeAuth } from "#public/channels/auth.js";
import { readLatestTaskReport } from "#subagents/remote/task-reports.js";
import { TASK_PROTOCOL_RESPONSE_FIELD } from "#eve-channel/task-protocol-request.js";
import type { EveChannelInput } from "#eve-channel/types.js";

const log = createLogger("eve.channel.session-report");

/**
 * Returns the latest result a delegated session reported to its caller for
 * one call. A calling eve deployment reads it once, at the call's deadline,
 * to recover a result whose callback never arrived. Besides the channel's
 * auth, the reader presents the callback token the report was sent to, so
 * only the caller that owns the call can read it. A missing session, a
 * call the session has not answered, and a report kept for another callback
 * all answer `report: null`.
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
  const callbackToken = req.headers.get(EVE_CALLBACK_TOKEN_HEADER);
  if (!callbackToken) {
    return Response.json(
      { error: `Missing the ${EVE_CALLBACK_TOKEN_HEADER} header.`, ok: false },
      { status: 400 },
    );
  }
  let report: Record<string, unknown> | undefined;
  try {
    report = await readLatestTaskReport({ callbackToken, callId, sessionId });
  } catch (error) {
    logError(log, "session report read failed", error, { sessionId });
  }
  return Response.json(
    { ok: true, report: report ?? null, ...TASK_PROTOCOL_RESPONSE_FIELD },
    { headers: { "cache-control": "no-store" } },
  );
}
