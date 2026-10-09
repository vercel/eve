import { defineEval } from "eve/evals";

import { calledTools, usesCatalog } from "./tool-use";

/** A shell request goes to `bash`; `eve__tool` only runs catalog entries. */
export default defineEval({
  tags: ["real-model"],
  description: "A request to inspect files with a shell command goes to bash, not eve__tool.",

  async test(t) {
    const turn = await t.send(
      [
        "Bob wants a quick look at the files in your working directory.",
        "Please run `ls -la` in a shell and tell him how many entries it lists.",
      ].join(" "),
    );

    turn.expectOk();
    turn.eventsSatisfy("bash is called, and the catalog isn't", (events) => {
      const called = calledTools(events);
      return called.includes("bash") && !called.some(usesCatalog);
    });
  },
});
