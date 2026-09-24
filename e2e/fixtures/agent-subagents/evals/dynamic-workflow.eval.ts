import { defineEval } from "eve/evals";

const SUBAGENT_TOKEN = "SUBAGENT_TOKEN=echo-marker-9F2X";
const DOUBLE_SUBAGENT_TOKEN = new RegExp(`${SUBAGENT_TOKEN}.*${SUBAGENT_TOKEN}`, "s");

function isFanOutProgram(input: unknown): boolean {
  if (typeof input !== "object" || input === null) return false;
  const js = (input as { js?: unknown }).js;
  return (
    typeof js === "string" &&
    js.includes("Promise.all") &&
    js.includes("echo-marker") &&
    js.includes("workflow alpha") &&
    js.includes("workflow beta")
  );
}

/** Generated workflow-program smoke: sandboxed JavaScript fans out durable children. */
export default defineEval({
  tags: ["real-model"],
  description:
    "Generated workflow-program smoke: model-authored JavaScript fans out two local subagent calls and combines their results.",
  async test(t) {
    const session = await t.session();
    const parent = await session.start(
      "Use the workflow tool exactly once to fan out two independent echo-marker subagent calls. In its JavaScript, create the messages 'workflow alpha' and 'workflow beta', map them through ctx.agent calls to echo-marker inside Promise.all, and return the resulting two-element array. Do not call echo-marker outside workflow. Then reply with the returned array verbatim as JSON.",
    );
    const firstCalled = await parent.waitForEvent("task.started", {
      data: { name: "echo-marker" },
    });
    const firstChildSessionId = firstCalled.data.child?.sessionId;
    if (firstChildSessionId === undefined) throw new Error("The first call has no child session.");
    const firstChild = t.target.watchTurn(firstChildSessionId).result();
    const secondCalled = await parent.waitForEvent("task.started", {
      data: {
        callId: (callId) => callId !== firstCalled.data.callId,
        name: "echo-marker",
      },
    });
    const secondChildSessionId = secondCalled.data.child?.sessionId;
    if (secondChildSessionId === undefined)
      throw new Error("The second call has no child session.");
    if (secondChildSessionId === firstChildSessionId) {
      throw new Error("Parallel workflow calls reused one child session.");
    }
    const secondChild = t.target.watchTurn(secondChildSessionId).result();
    const [turn, firstChildTurn, secondChildTurn] = await Promise.all([
      parent.result(),
      firstChild,
      secondChild,
    ]);
    const latestCallAt = [firstCalled.meta.at, secondCalled.meta.at].sort().at(-1)!;

    t.succeeded();
    t.calledTool("workflow", { input: isFanOutProgram, count: 1 });
    turn.calledSubagent("echo-marker", { count: 2, status: "completed" });
    firstChildTurn.eventsSatisfy(
      "first child does not complete before both children start",
      (events) =>
        events.some((event) => event.type === "turn.completed" && event.meta.at > latestCallAt),
    );
    secondChildTurn.eventsSatisfy(
      "second child does not complete before both children start",
      (events) =>
        events.some((event) => event.type === "turn.completed" && event.meta.at > latestCallAt),
    );
    firstChildTurn.messageIncludes(SUBAGENT_TOKEN);
    secondChildTurn.messageIncludes(SUBAGENT_TOKEN);
    t.messageIncludes(DOUBLE_SUBAGENT_TOKEN);
    t.noFailedActions();
  },
});
