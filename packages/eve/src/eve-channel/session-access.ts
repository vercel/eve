import { sessionAuthFromResult } from "#channel/auth/result.js";
import { readSessionCreator } from "#execution/session-creator.js";
import { createLogger, logError } from "#internal/logging.js";
import type { EveAuthResult, EveChannelConfig } from "#eve-channel/types.js";

const log = createLogger("eve.channel.session-access");

export async function checkSessionAccess(
  config: EveChannelConfig,
  request: Request,
  caller: EveAuthResult,
  sessionId: string,
): Promise<Response | undefined> {
  if (config.authorizeSession === undefined) return undefined;
  let errorId: string | undefined;
  try {
    const allowed = await config.authorizeSession({
      caller: sessionAuthFromResult(caller),
      request,
      sessionId,
      getCreator: () => readSessionCreator(sessionId),
    });
    if (allowed === true) return undefined;
  } catch (error) {
    errorId = logError(log, "Session authorization failed", error);
  }
  return Response.json(
    { ok: false, error: "Session access denied.", ...(errorId !== undefined && { errorId }) },
    { status: 403, headers: { "cache-control": "no-store" } },
  );
}
