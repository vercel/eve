import { loadContext } from "#context/container.js";
import { ProgressCallbackKey, SessionKey } from "#context/keys.js";
import { postSessionCallbackRequest } from "#execution/session-callback-request.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import {
  normalizeProgressText,
  progressTurnId,
  type ProgressCommandV1,
} from "#execution/session-progress.js";
import { resumeHook } from "#internal/workflow/runtime.js";

/** Queues a replace-in-place report owned by the current agent turn. */
export async function reportProgress(input: {
  readonly callId: string;
  readonly message: unknown;
}): Promise<{ readonly status: "queued" }> {
  const message = typeof input.message === "string" ? normalizeProgressText(input.message) : "";
  if (message === "") throw new Error("Provide a non-empty `message`.");

  const context = loadContext();
  const session = context.require(SessionKey);
  const now = new Date().toISOString();
  const id = `report:${session.sessionId}:${session.turn.id}:${input.callId}`;
  const command: ProgressCommandV1 = {
    commandId: id,
    events: [
      {
        eventId: id,
        kind: "report",
        report: { id: input.callId, message, reportedAt: now },
        turn: {
          id: progressTurnId(session.sessionId, session.turn.id),
          phase: "running",
          sequence: session.turn.sequence,
          startedAt: now,
        },
      },
    ],
    kind: "progress",
    version: 1,
  };

  const callback = context.get(ProgressCallbackKey);
  if (callback !== undefined) {
    const response = await postSessionCallbackRequest({
      body: { command, kind: "session.progress", version: 1 },
      url: callback.url,
    });
    if (!response.ok) throw new Error(`Progress callback failed with HTTP ${response.status}.`);
  } else {
    await resumeHook(
      sessionCommandHookToken(session.parent?.rootSessionId ?? session.sessionId),
      command,
    );
  }
  return { status: "queued" };
}
