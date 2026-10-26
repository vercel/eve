import { defineEval } from "eve/evals";

const MESSAGES = ["limit alpha", "limit beta", "limit gamma", "limit delta"] as const;
const CHILD_TOKEN = "SUBAGENT_TOKEN=echo-marker-9F2X";
const LIMIT_ERROR = "WORKFLOW_PROGRAM_SUBAGENT_LIMIT_REACHED";
// Models that honor the tool's advertised limit won't write the fourth call
// themselves, so the eval hands them the program to run unchanged.
const PROGRAM = [
  "const results = [];",
  'results.push(await ctx.agent("echo-marker", { message: "limit alpha" }));',
  'results.push(await ctx.agent("echo-marker", { message: "limit beta" }));',
  'results.push(await ctx.agent("echo-marker", { message: "limit gamma" }));',
  "try {",
  '  results.push(await ctx.agent("echo-marker", { message: "limit delta" }));',
  "} catch (error) {",
  "  results.push(error instanceof Error ? error.message : String(error));",
  "}",
  "return results;",
].join("\n");

function isFourCallProgram(input: unknown): boolean {
  if (typeof input !== "object" || input === null) return false;
  const js = (input as { readonly js?: unknown }).js;
  if (typeof js !== "string") return false;
  const positions = MESSAGES.map((message) => js.indexOf(message));
  return (
    positions.every((position) => position >= 0) &&
    positions.every((position, index) => index === 0 || position > positions[index - 1]!) &&
    js.includes("ctx.agent") &&
    js.includes("catch")
  );
}

function isFourElementLimitResult(output: unknown): boolean {
  return (
    Array.isArray(output) &&
    output.length === 4 &&
    output.slice(0, 3).every((value) => typeof value === "string" && value.includes(CHILD_TOKEN)) &&
    typeof output[3] === "string" &&
    output[3].includes(LIMIT_ERROR)
  );
}

/**
 * Generated-program subagent budget: the authored `workflow` tool passes
 * `maxSubagents: 3`, so four sequential calls spawn three children and the fourth
 * call throws a catchable `WORKFLOW_PROGRAM_SUBAGENT_LIMIT_REACHED` error after replay.
 */
export default defineEval({
  tags: ["real-model"],
  description:
    "Sequential generated-program calls share one maxSubagents budget and resolve excess calls with WORKFLOW_PROGRAM_SUBAGENT_LIMIT_REACHED.",
  async test(t) {
    await t.send(
      [
        "Alice is checking that the workflow tool enforces its agent budget. The program below makes one more agent call than the tool allows, and catching that call's error is what she is checking.",
        "Use the workflow tool exactly once and pass this program as its js, unchanged:",
        "",
        "```js",
        PROGRAM,
        "```",
        "",
        "Do not call echo-marker outside workflow and do not retry. Then reply with the returned array verbatim as JSON.",
      ].join("\n"),
    );

    t.succeeded();
    t.calledTool("workflow", { count: 1, input: isFourCallProgram });
    // The workflow tool runs as a task: its result settles the task, not the call.
    t.event("call.settled", {
      count: 1,
      data: { output: isFourElementLimitResult, outcome: "completed" },
    });
    t.event("child.opened", { count: 3, data: { name: "echo-marker" } });
    t.messageIncludes("WORKFLOW_PROGRAM_SUBAGENT_LIMIT_REACHED");
  },
});
