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
  tags: ["real-model"],
  description:
    "Dynamic Workflow smoke: model-authored JavaScript fans out two local subagent calls and combines their results.",
  async test(t) {
    const turn = await t.send(
      "Use the Workflow tool exactly once to fan out two independent echo-marker subagent calls. In its JavaScript, create the messages 'workflow alpha' and 'workflow beta', map them through echo-marker inside Promise.all, and return the resulting two-element array. Do not call echo-marker outside Workflow. Then reply with the returned array verbatim as JSON.",
    );

    t.succeeded();
    t.calledTool("Workflow", { input: isFanOutProgram, count: 1 });
    // Workflow delivery can replay either event; count logical calls, not deliveries.
    turn.eventsSatisfy("both distinct children start before either completes", (events) => {
      const called = new Map<string, number>();
      const completed = new Map<string, number>();
      for (const [index, event] of events.entries()) {
        if (event.type === "subagent.called" && event.data.name === "echo-marker") {
          if (!called.has(event.data.callId)) called.set(event.data.callId, index);
        }
        if (event.type === "subagent.completed" && event.data.subagentName === "echo-marker") {
          if (!completed.has(event.data.callId)) completed.set(event.data.callId, index);
        }
      }
      return (
        called.size === 2 &&
        completed.size === 2 &&
        [...completed.keys()].every((callId) => called.has(callId)) &&
        Math.max(...called.values()) < Math.min(...completed.values())
      );
    });
    t.calledSubagent("echo-marker", {
      output: /SUBAGENT_TOKEN=echo-marker-9F2X/,
      count: 2,
    });
    t.messageIncludes(DOUBLE_SUBAGENT_TOKEN);
    t.noFailedActions();
  },
});
