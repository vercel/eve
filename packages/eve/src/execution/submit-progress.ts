import type { ContextContainer } from "#context/container.js";
import { ProgressCallbackKey, SessionKey } from "#context/keys.js";
import { postSessionCallbackRequest } from "#execution/session-callback-request.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import type { ProgressCommandV1 } from "#execution/session-progress.js";
import { resumeHook } from "#internal/workflow/runtime.js";

/** Submits one progress command over the inherited remote route or local root inbox. */
export async function submitProgressCommand(
  context: ContextContainer,
  command: ProgressCommandV1,
): Promise<void> {
  const callback = context.get(ProgressCallbackKey);
  if (callback !== undefined) {
    const response = await postSessionCallbackRequest({
      body: { command, kind: "session.progress", version: 1 },
      url: callback.url,
    });
    if (!response.ok) throw new Error(`Progress callback failed with HTTP ${response.status}.`);
    return;
  }

  const session = context.require(SessionKey);
  await resumeHook(
    sessionCommandHookToken(session.parent?.rootSessionId ?? session.sessionId),
    command,
  );
}
