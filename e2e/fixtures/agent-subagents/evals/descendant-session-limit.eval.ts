import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

const CHILD_TOKEN = "CHILD_LIMIT_CONTINUED";
const ROOT_RECOVERY_TOKEN = "ROOT_AFTER_DESCENDANT_STOP";

const DELEGATE_PROMPT = [
  "Call the limited-worker subagent exactly once.",
  "Tell it to follow its instructions.",
  `After it returns, reply with exactly ${CHILD_TOKEN} and nothing else.`,
].join(" ");

/**
 * The limited child crosses its one-token budget after calling complete-step.
 * Its continuation prompt must surface on the root session and the answer must
 * route back to the child that minted it.
 */
export default defineEval({
  tags: ["real-model"],
  description:
    "A descendant session-limit prompt reaches the root; continue resumes the child and stop leaves the root session reusable.",
  timeoutMs: 90_000,
  async test(t) {
    await t.send(DELEGATE_PROMPT);
    const continueRequest = t.requireInputRequest({
      display: "confirmation",
      optionIds: ["continue", "stop"],
      toolName: "session_limit_continuation",
    });
    const rootSessionId = t.sessionId;
    if (rootSessionId === undefined) {
      throw new Error("The root session did not expose its session id.");
    }
    await t.require(
      continueRequest.requestId,
      satisfies(
        (requestId: string) => !requestId.startsWith(`${rootSessionId}:limit:`),
        "continuation request belongs to a descendant session",
      ),
    );

    const resumed = await t.respond({
      optionId: "continue",
      requestId: continueRequest.requestId,
    });
    resumed.expectOk();
    t.succeeded();
    t.calledSubagent("limited-worker", { count: 1, output: CHILD_TOKEN });
    t.messageIncludes(CHILD_TOKEN);
    t.noFailedActions();

    const stopSession = t.newSession();
    await stopSession.send(DELEGATE_PROMPT);
    const stopRequest = stopSession.requireInputRequest({
      display: "confirmation",
      optionIds: ["continue", "stop"],
      toolName: "session_limit_continuation",
    });

    const stopped = await stopSession.respond({
      optionId: "stop",
      requestId: stopRequest.requestId,
    });
    stopped.expectOk();
    stopSession.notEvent("turn.failed");
    stopSession.notEvent("session.failed");
    stopSession.notEvent("session.completed");
    stopSession.event("turn.cancelled");
    t.check(stopped.status, equals("waiting"));

    const recovered = await stopSession.send(
      `Do not call any tool or subagent. Reply with exactly ${ROOT_RECOVERY_TOKEN} and nothing else.`,
    );
    recovered.expectOk();
    stopSession.succeeded();
    stopSession.calledSubagent("limited-worker", { count: 1, status: "pending" });
    stopSession.messageIncludes(ROOT_RECOVERY_TOKEN);
  },
});
