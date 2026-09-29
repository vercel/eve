import { defineEval, type EveEvalTargetHandle } from "eve/evals";
import { equals } from "eve/evals/expect";

type Actor = "alice" | "bob";

async function post(target: EveEvalTargetHandle, path: string, body: object) {
  const response = await target.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}.`);
  return (await response.json()) as { sessionId: string };
}

function respond(
  target: EveEvalTargetHandle,
  input: { threadId: string; actor: Actor; requestId: string; optionId: string },
) {
  return post(target, "/skill-context/respond", input);
}

/**
 * Alice asks for a release in a thread Bob also takes part in. The sign-off
 * question has a policy allowing Alice to answer. Bob answers first
 * and his answer is rejected; Alice's answer is the one the release receives.
 */
export default defineEval({
  description: "A requester-only question accepts only the requester's answer.",
  async test(t) {
    const threadId = crypto.randomUUID();
    const started = await post(t.target, "/skill-context/send", {
      threadId,
      actor: "alice",
      message: "WORKFLOW-SIGNOFF-START Alice asks to release the api service.",
    });
    const parked = await t.target.watchTurn(started.sessionId).result();
    t.check(parked.status, equals("waiting")).label("the release waits for a sign-off");
    const requested = parked.events.find((event) => event.type === "input.requested");
    if (requested?.type !== "input.requested") throw new Error("The sign-off question is missing.");
    const [question] = requested.data.requests;
    if (question === undefined) throw new Error("The sign-off question is missing.");
    t.check(question.responsePolicy, equals(true)).label("answers require response authorization");

    const startIndex = parked.session.state.streamIndex;
    await respond(t.target, {
      threadId,
      actor: "bob",
      requestId: question.requestId,
      optionId: "cancel",
    });
    await respond(t.target, {
      threadId,
      actor: "alice",
      requestId: question.requestId,
      optionId: "approve",
    });

    const released = await t.target.watchTurn(started.sessionId, { startIndex }).result();
    released.expectOk();
    released.event("input.resolved", {
      count: 1,
      data: {
        resolutions: [
          { outcome: "answered", requestId: question.requestId, response: { optionId: "approve" } },
        ],
      },
    });
    released.event("action.result", {
      count: 1,
      data: {
        result: { output: /"released":true/u, toolName: "release_signoff" },
        status: "completed",
      },
    });
    t.noFailedActions();
  },
});
