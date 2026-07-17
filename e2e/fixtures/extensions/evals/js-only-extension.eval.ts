import { defineEval } from "eve/evals";

const JS_ONLY_EXTENSION_TOKEN = "js-only-extension-dist-ok-4N7Q";

export default defineEval({
  description: "A JavaScript-only extension runs from its publisher-built dist tree.",
  async test(t) {
    await t.send("Call the `javascript__js_ping` tool and report exactly what it returned.");

    t.succeeded();
    t.calledTool("javascript__js_ping", {
      output: { reply: JS_ONLY_EXTENSION_TOKEN },
    });
    t.messageIncludes(JS_ONLY_EXTENSION_TOKEN);
  },
});
