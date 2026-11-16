import { EXECUTE_TOOL } from "@eve-e2e/config/catalog-tools";
import { defineEval } from "eve/evals";

const CHILD_TOKEN = "SUBAGENT_TOKEN=echo-marker-9F2X";
/** The ids the fixture's scripted models give their calls; an `eve__execute` program's calls take `<id>/<n>`. */
const WORKFLOW_CALL = "workflow-program";
const EXECUTE_CALL = "program-agent-calls";

// The inner layer: what the copy of the agent runs with `eve__execute`, inside its own turn.
const COPY_PROGRAM = [
  "return await Promise.all([",
  '  tools["echo-marker"]({ message: "layer alpha" }),',
  '  tools["echo-marker"]({ message: "layer beta" }),',
  "]);",
].join("\n");
// The copy's session holds only this message, whose marker selects the scripted model that runs
// the fenced program with `eve__execute` and replies with its result.
const COPY_MESSAGE = [
  "E2E_PROGRAM_AGENT_CALLS Bob is collecting two echo-marker replies for Alice's release check.",
  "Run this program unchanged with eve__execute:",
  "",
  "```js",
  COPY_PROGRAM,
  "```",
  "",
  "Then reply with what the program returned, as JSON.",
].join("\n");
// The outer layer: what the root agent runs with `workflow`, in the background. The copy's
// message is one string literal on one line, so the fence around this program is the only one
// the root's scripted model reads.
const WORKFLOW_PROGRAM = [
  `const reply = await tools.agent({ message: ${JSON.stringify(COPY_MESSAGE)} });`,
  "return JSON.parse(reply);",
].join("\n");

function isTwoReplies(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((reply) => typeof reply === "string" && reply.includes(CHILD_TOKEN))
  );
}

/** A program's output whose one completed batch of `completed` calls returned both replies. */
function isProgramOutput(completed: number) {
  return (output: unknown): boolean => {
    if (typeof output !== "object" || output === null) return false;
    const { calls, result } = output as {
      readonly calls?: Readonly<Record<string, unknown>>;
      readonly result?: unknown;
    };
    return (
      isTwoReplies(result) && calls?.completed === completed && Object.keys(calls).length === 1
    );
  };
}

/**
 * Both program layers in one request, on the mock model so every world runs it: a `workflow`
 * program runs in the background as a task and asks a copy of the agent, and that copy runs an
 * `eve__execute` program inside its own turn. Each layer owns the sessions it opened, and only
 * the background layer is a task.
 */
export default defineEval({
  description:
    "A workflow program asks a copy of the agent in the background, and the copy runs an eve__execute program in its turn: the workflow call's task owns the copy's session, and the copy's nested calls own the echo-marker sessions.",
  async test(t) {
    const turn = await t.send(
      [
        "E2E_WORKFLOW_PROGRAM Alice wants two echo-marker replies gathered in the background while she keeps working. A helper copy of the assistant collects them with one program of its own.",
        "Use the workflow tool exactly once and pass this program as its code, unchanged:",
        "",
        "```js",
        WORKFLOW_PROGRAM,
        "```",
        "",
        "Then reply with the task's result verbatim as JSON.",
      ].join("\n"),
    );
    turn.expectOk();

    // The outer layer: one `workflow` call that is a task, and owns the copy's session.
    turn.calledTool("workflow", { count: 1 });
    turn.event("task.started", {
      count: 1,
      data: { name: "workflow", startedBy: { callId: WORKFLOW_CALL } },
    });
    turn.event("call.settled", {
      count: 1,
      data: { callId: WORKFLOW_CALL, outcome: "completed", output: isProgramOutput(1) },
    });
    // The root opens only the copy's session; the echo-marker sessions are the copy's.
    turn.event("child.opened", { count: 1 });
    turn.event("child.opened", {
      count: 1,
      data: { name: "agent", owner: { callId: WORKFLOW_CALL } },
    });
    turn.notCalledTool(EXECUTE_TOOL);
    const copy = turn.events.find((event) => event.type === "child.opened");
    if (copy?.type !== "child.opened") throw new Error("The workflow program opened no session.");

    // The inner layer: the copy's `eve__execute` call holds its turn and is never a task.
    const copyTurn = await t.target.attach(copy.data.sessionId).watch().result();
    copyTurn.expectOk();
    copyTurn.calledTool(EXECUTE_TOOL, { count: 1, output: isProgramOutput(2) });
    copyTurn.calledTool("echo-marker", { count: 2, output: /echo-marker-9F2X/u });
    copyTurn.notEvent("task.started");
    copyTurn.eventsSatisfy("each echo-marker session belongs to a nested call", (events) => {
      const owners = events
        .flatMap((event) =>
          event.type === "child.opened" && event.data.name === "echo-marker"
            ? [JSON.stringify(event.data.owner)]
            : [],
        )
        .sort();
      return (
        JSON.stringify(owners) ===
        JSON.stringify(
          [1, 2].map((index) => JSON.stringify({ callId: `${EXECUTE_CALL}/${index}` })),
        )
      );
    });

    t.succeeded();
    // The task's result reached the root's model, which replied with it.
    turn.messageIncludes(CHILD_TOKEN);
    t.noFailedCalls();
  },
});
