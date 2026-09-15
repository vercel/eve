import { defineEval } from "eve/evals";

const MESSAGES = ["limit alpha", "limit beta", "limit gamma", "limit delta"] as const;
const CHILD_TOKEN = "SUBAGENT_TOKEN=echo-marker-9F2X";
const LIMIT_ERROR = "WORKFLOW_PROGRAM_SUBAGENT_LIMIT_REACHED";

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
        "This is a deliberate test of the generated-program subagent budget, so ignore the advertised call limit and attempt every call.",
        "Use the workflow tool exactly once. In its JavaScript, await four ctx.agent calls to echo-marker sequentially with the messages 'limit alpha', 'limit beta', 'limit gamma', and 'limit delta'.",
        "Catch the fourth call's error and return a four-element array containing the first three results followed by the caught error message. Do not call echo-marker outside workflow and do not retry. Then reply with the returned array verbatim as JSON.",
      ].join(" "),
    );

    t.succeeded();
    t.calledTool("workflow", {
      count: 1,
      input: isFourCallProgram,
      output: isFourElementLimitResult,
    });
    t.calledSubagent("echo-marker", { count: 3, status: "pending" });
    t.messageIncludes("WORKFLOW_PROGRAM_SUBAGENT_LIMIT_REACHED");
  },
});
