import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Code Mode preserves direct authored tools and subagents while discovering dynamic tools lazily.",
  async test(t) {
    const turn = await t.send("CODEMODE-SURFACE-START");
    turn.expectOk();
    for (const name of [
      "code_mode",
      "bash",
      "read_file",
      "write_file",
      "todo",
      "echo",
      "marker",
      "gated",
      "background",
      "plan_deploy",
      "connection_search",
    ]) {
      turn.messageIncludes(new RegExp(`(?:\\[|,)${name}(?:,|\\])`, "u"));
    }
  },
});
