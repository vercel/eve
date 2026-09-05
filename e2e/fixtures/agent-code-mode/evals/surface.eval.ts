import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Eager exposes direct tools and subagents alongside code_mode, including dynamic tools.",
  async test(t) {
    const turn = await t.send("CODEMODE-SURFACE-START");
    turn.expectOk();
    for (const name of [
      "code_mode",
      "echo",
      "marker",
      "shared",
      "discovered",
      "gated",
      "background",
      "connection_search",
    ]) {
      turn.messageIncludes(new RegExp(`(?:\\[|,)${name}(?:,|\\])`, "u"));
    }
  },
});
