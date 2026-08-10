import { defineEval, type EveEvalTargetHandle } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { waitForTaskInput } from "./shared.js";

interface ResetResponse {
  readonly ok?: boolean;
  readonly previousSessionId?: string;
  readonly status?: string;
}

/** Parent reset retires the session while its background task is waiting for input. */
export default defineEval({
  description: "Reset reports the parent session whose background task is waiting for input.",
  async test(t) {
    const started = await t.send("TASK-CANCEL-SETUP");
    started.expectOk();
    started.messageIncludes("TASK-CANCEL-READY");

    const blocked = await waitForTaskInput(t, t, "release");
    const previousSessionId = blocked.session.sessionId;
    if (previousSessionId === undefined) {
      throw new Error("The blocked task has no parent session id.");
    }
    const continuationToken = t.state.continuationToken;
    if (continuationToken === undefined) {
      throw new Error("The parent session has no continuation token.");
    }

    const reset = await postReset(t.target, continuationToken);
    await t.require(
      reset,
      satisfies(
        (value: ResetResponse) =>
          value.ok === true &&
          value.status === "reset" &&
          value.previousSessionId === previousSessionId,
        "reset identifies the blocked task's previous parent session",
      ),
    );
  },
});

async function postReset(
  target: EveEvalTargetHandle,
  continuationToken: string,
): Promise<ResetResponse> {
  const response = await target.fetch("/eve/v1/session/reset", {
    body: JSON.stringify({ continuationToken }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Parent reset failed (${response.status}): ${body}`);
  }
  return JSON.parse(body) as ResetResponse;
}
