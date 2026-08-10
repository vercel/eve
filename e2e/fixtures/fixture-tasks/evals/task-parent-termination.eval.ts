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
    const sessionId = blocked.session.sessionId;
    if (sessionId === undefined) {
      throw new Error("The blocked task has no parent session id.");
    }

    const reset = await postReset(t.target, sessionId);
    await t.require(
      reset,
      satisfies(
        (value: ResetResponse) =>
          value.ok === true && value.status === "reset" && value.previousSessionId === sessionId,
        "reset identifies the blocked task's previous parent session",
      ),
    );
  },
});

async function postReset(target: EveEvalTargetHandle, sessionId: string): Promise<ResetResponse> {
  const response = await target.fetch(`/eve/v1/session/${sessionId}/reset`, {
    body: JSON.stringify({}),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Parent reset failed (${response.status}): ${body}`);
  }
  return JSON.parse(body) as ResetResponse;
}
