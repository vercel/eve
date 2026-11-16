import { EXECUTE_TOOL } from "@eve-e2e/config/catalog-tools";
import { defineEval } from "eve/evals";

const CHILD_TOKEN = "SUBAGENT_TOKEN=echo-marker-9F2X";
/**
 * The id the scripted model gives its `eve__execute` call; nested calls take `<id>/<n>`. The root
 * and its copy run the same script in separate sessions, so both use this id.
 */
const PROGRAM_CALL = "program-agent-calls";

// What the copy of the agent runs with `eve__execute`, inside its own turn.
const COPY_PROGRAM = [
  "return await Promise.all([",
  '  tools["echo-marker"]({ message: "helper alpha" }),',
  '  tools["echo-marker"]({ message: "helper beta" }),',
  "]);",
].join("\n");
// The copy's session holds only this message, whose marker selects the scripted model that runs
// the fenced program and replies with its result.
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
// What the root runs. The copy's message is one string literal on one line, so the fence around
// this program is the only one the root's scripted model reads.
const ROOT_PROGRAM = [
  `const reply = await tools.agent({ message: ${JSON.stringify(COPY_MESSAGE)} });`,
  "return JSON.parse(reply);",
].join("\n");

/** A program's output: both echo-marker replies, after `completed` calls and none that failed. */
function isProgramOutput(completed: number) {
  return (output: unknown): boolean => {
    if (typeof output !== "object" || output === null) return false;
    const { calls, result } = output as {
      readonly calls?: Readonly<Record<string, unknown>>;
      readonly result?: unknown;
    };
    return (
      Array.isArray(result) &&
      result.length === 2 &&
      result.every((reply) => typeof reply === "string" && reply.includes(CHILD_TOKEN)) &&
      calls?.completed === completed &&
      Object.keys(calls).length === 1
    );
  };
}

/**
 * A program inside a child session, on the mock model so every world runs it: the root's program
 * waits on a copy of the agent, and the copy's own program waits on two echo-marker sessions.
 * Each program holds its own session's turn, owns the sessions its calls open, and starts no task.
 */
export default defineEval({
  description:
    "A program asks a copy of the agent, and the copy runs a program of its own in its turn: each program's nested calls own the sessions they open, neither starts a task, and the root's program resumes with the copy's reply.",
  async test(t) {
    const turn = await t.send(
      [
        "E2E_PROGRAM_AGENT_CALLS Alice wants two echo-marker replies before a release. A helper copy of the assistant gathers them with one program of its own, and Alice's program passes them on.",
        "Run this program unchanged with eve__execute:",
        "",
        "```js",
        ROOT_PROGRAM,
        "```",
        "",
        "Then reply with what the program returned, as JSON.",
      ].join("\n"),
    );
    turn.expectOk();

    // The root's program makes one call, to the copy, and returns what the copy's program returned.
    turn.calledTool(EXECUTE_TOOL, { count: 1, output: isProgramOutput(1) });
    turn.notEvent("task.started");
    // The root opens only the copy's session; the echo-marker sessions are the copy's.
    turn.event("child.opened", { count: 1 });
    turn.event("child.opened", {
      count: 1,
      data: { name: "agent", owner: { callId: `${PROGRAM_CALL}/1` } },
    });
    const copy = turn.events.find((event) => event.type === "child.opened");
    if (copy?.type !== "child.opened") throw new Error("The root's program opened no session.");

    // The copy has code mode too: its program holds its turn and owns both echo-marker sessions.
    const copyTurn = await t.target.attach(copy.data.sessionId).watch().result();
    copyTurn.expectOk();
    copyTurn.calledTool(EXECUTE_TOOL, { count: 1, output: isProgramOutput(2) });
    copyTurn.calledTool("echo-marker", { count: 2, output: /echo-marker-9F2X/u });
    copyTurn.notEvent("task.started");
    copyTurn.event("child.opened", { count: 2 });
    for (const index of [1, 2]) {
      copyTurn.event("child.opened", {
        count: 1,
        data: { name: "echo-marker", owner: { callId: `${PROGRAM_CALL}/${index}` } },
      });
    }

    t.succeeded();
    turn.messageIncludes(CHILD_TOKEN);
    t.noFailedCalls();
  },
});
