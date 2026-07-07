import { defineEval } from "eve/evals";

// agent/extensions/toolkit/tools/toolkit_ping.ts shadows the mounted toolkit
// ping: a directory-mount's co-located override wins over the extension's own
// same-named contribution ("toolkit-extension-ping").
export default defineEval({
  description: "A directory-mount override shadows a mounted extension tool of the same name.",
  async test(t) {
    await t.send("Call the `toolkit__toolkit_ping` tool and report exactly what it returned.");

    t.succeeded();
    t.calledTool("toolkit__toolkit_ping", { output: { reply: "consumer-override-ping" } });
  },
});
