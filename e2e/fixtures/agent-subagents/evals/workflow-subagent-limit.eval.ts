import { defineEval } from "eve/evals";

const MESSAGES = ["limit alpha", "limit beta", "limit gamma", "limit delta"] as const;
const CHILD_TOKEN = "SUBAGENT_TOKEN=echo-marker-9F2X";
// The fixture's `workflow({ maxSubagents: 3 })` sets the number this message carries.
const LIMIT_ERROR =
  'EXECUTE_AGENT_LIMIT_REACHED: a program may call agents at most 3 times; "echo-marker" was not called.';
// The program makes one more agent call than the tool allows. The marker in the
// message selects a scripted parent that runs it unchanged, since a live model
// that honors the advertised limit may refuse to.
const PROGRAM = [
  "const results = [];",
  'results.push(await tools["echo-marker"]({ message: "limit alpha" }));',
  'results.push(await tools["echo-marker"]({ message: "limit beta" }));',
  'results.push(await tools["echo-marker"]({ message: "limit gamma" }));',
  "try {",
  '  results.push(await tools["echo-marker"]({ message: "limit delta" }));',
  "} catch (error) {",
  "  results.push(error.message);",
  "}",
  "return results;",
].join("\n");

function isFourCallProgram(input: unknown): boolean {
  if (typeof input !== "object" || input === null) return false;
  const code = (input as { readonly code?: unknown }).code;
  if (typeof code !== "string") return false;
  const positions = MESSAGES.map((message) => code.indexOf(message));
  return (
    positions.every((position) => position >= 0) &&
    positions.every((position, index) => index === 0 || position > positions[index - 1]!) &&
    code.includes('tools["echo-marker"]') &&
    code.includes("catch")
  );
}

/** The task's result: three replies, then the fourth call's limit error, with both counted. */
function isLimitedProgramOutput(output: unknown): boolean {
  if (typeof output !== "object" || output === null) return false;
  const { calls, result } = output as {
    readonly calls?: Readonly<Record<string, unknown>>;
    readonly result?: unknown;
  };
  return (
    Array.isArray(result) &&
    result.length === 4 &&
    result.slice(0, 3).every((value) => typeof value === "string" && value.includes(CHILD_TOKEN)) &&
    result[3] === LIMIT_ERROR &&
    calls?.completed === 3 &&
    calls.failed === 1
  );
}

/**
 * A workflow program's agent budget: the authored `workflow` tool passes
 * `maxSubagents: 3`, so four sequential calls open three child sessions and the fourth
 * call throws a catchable `EXECUTE_AGENT_LIMIT_REACHED` error without opening one.
 */
export default defineEval({
  description:
    "Sequential workflow-program calls share one maxSubagents budget: the call over it throws EXECUTE_AGENT_LIMIT_REACHED, which the program catches, and opens no session.",
  async test(t) {
    await t.send(
      [
        "E2E_WORKFLOW_PROGRAM Alice is checking that the workflow tool keeps a program within its agent budget. The program below asks the echo-marker assistant one more time than the tool allows, and noting that last call's error is what she is checking.",
        "Use the workflow tool exactly once and pass this program as its code, unchanged:",
        "",
        "```js",
        PROGRAM,
        "```",
        "",
        "Ask echo-marker only from that program, once per call. Then reply with the task's result verbatim as JSON.",
      ].join("\n"),
    );

    t.succeeded();
    t.calledTool("workflow", { count: 1, input: isFourCallProgram });
    // The workflow tool runs as a task: its result settles the task, not the call.
    t.event("task.started", { count: 1, data: { name: "workflow" } });
    t.event("call.settled", {
      count: 1,
      data: { output: isLimitedProgramOutput, outcome: "completed" },
    });
    t.event("child.opened", { count: 3, data: { name: "echo-marker" } });
    t.messageIncludes("EXECUTE_AGENT_LIMIT_REACHED");
  },
});
