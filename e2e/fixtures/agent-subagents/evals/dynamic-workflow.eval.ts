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

/** Dynamic Workflow smoke: sandboxed JavaScript fans out durable children. */
export default defineEval({
  description:
    "Dynamic Workflow smoke: model-authored JavaScript fans out two local subagent calls and combines their results.",
  async test(t) {
    const turn = await t.send(
      "Use the Workflow tool exactly once to fan out two independent echo-marker subagent calls. In its JavaScript, create the messages 'workflow alpha' and 'workflow beta', map them through echo-marker inside Promise.all, and return the resulting two-element array. Do not call echo-marker outside Workflow. Then reply with the returned array verbatim as JSON.",
    );
    turn.expectOk();

    t.didNotFail();
    t.completed();
    t.calledTool("Workflow", { input: isFanOutProgram, times: 1 });
    t.event((events) => {
      const calledIndexes = events.flatMap((event, index) =>
        event.type === "subagent.called" && event.data.name === "echo-marker" ? [index] : [],
      );
      const firstCompletedIndex = events.findIndex(
        (event) => event.type === "subagent.completed" && event.data.subagentName === "echo-marker",
      );
      return (
        calledIndexes.length === 2 &&
        firstCompletedIndex >= 0 &&
        calledIndexes.every((index) => index < firstCompletedIndex)
      );
    }, "Workflow dispatched exactly two echo-marker children before either completed");
    t.calledSubagent("echo-marker", { output: /SUBAGENT_TOKEN=echo-marker-9F2X/ });
    t.messageIncludes(DOUBLE_SUBAGENT_TOKEN);
    t.noFailedActions();
  },
});
