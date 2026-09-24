import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

const CHILD_TOKEN = "CHILD_LIMIT_CONTINUED";
const ROOT_RECOVERY_TOKEN = "ROOT_AFTER_DESCENDANT_STOP";

const DELEGATE_PROMPT = [
  "Call the limited-worker subagent exactly once.",
  "Tell it to follow its instructions.",
  `After it returns, reply with exactly ${CHILD_TOKEN} and nothing else.`,
].join(" ");

/**
 * The limited child crosses its one-token budget after calling complete-step.
 * While the root turn waits on the child, the child's continuation prompt must
 * surface on the root session and the answer must route back to the child
 * that minted it.
 */
export default defineEval({
  tags: ["real-model"],
  description:
    "A descendant session-limit prompt reaches the root; continue resumes the child and stop leaves the root session reusable.",
  timeoutMs: 90_000,
  async test(t) {
    const blocked = await t.send(DELEGATE_PROMPT);
    const continueRequest = blocked.session.requireInputRequest({
      display: "confirmation",
      optionIds: ["continue", "stop"],
      toolName: "session_limit_continuation",
    });
    const rootSessionId = blocked.sessionId;
    await t.require(
      continueRequest.requestId,
      satisfies(
        (requestId: string) => !requestId.startsWith(`${rootSessionId}:limit:`),
        "continuation request belongs to a descendant session",
      ),
    );

    // Continuing resumes the child; its result returns to the same root turn.
    const resumed = await blocked.session.respond([
      {
        optionId: "continue",
        requestId: continueRequest.requestId,
      },
    ]);
    resumed.expectOk();
    resumed.calledSubagent("limited-worker", { status: "completed", count: 1 });
    resumed.messageIncludes(CHILD_TOKEN);
    t.noFailedActions();

    const stopSession = await t.session();
    const stopBlocked = await stopSession.send(DELEGATE_PROMPT);
    const stopRequest = stopBlocked.session.requireInputRequest({
      display: "confirmation",
      optionIds: ["continue", "stop"],
      toolName: "session_limit_continuation",
    });

    const stopped = await stopBlocked.session.respond([
      {
        optionId: "stop",
        requestId: stopRequest.requestId,
      },
    ]);
    stopped.expectOk();
    stopped.notEvent("turn.failed");
    stopped.notEvent("session.failed");
    stopped.notEvent("session.completed");

    const recovered = await stopped.session.send(
      `Do not call any tool or subagent. Reply with exactly ${ROOT_RECOVERY_TOKEN} and nothing else.`,
    );
    recovered.expectOk();
    stopSession.event("task.started", { data: { name: "limited-worker" }, count: 1 });
    recovered.messageIncludes(ROOT_RECOVERY_TOKEN);
  },
});
