import { defineEval } from "eve/evals";

export default defineEval({
  tags: ["real-model"],
  description: "A directory-mount override shadows a mounted extension tool of the same name.",
  async test(t) {
    await t.send({
      message: "Call the `toolkit__toolkit_ping` tool and report exactly what it returned.",
    });

    t.succeeded();
    t.calledTool("toolkit__toolkit_ping", { output: { reply: "consumer-override-ping" } });
  },
});
