import { defineEval } from "eve/evals";

export default defineEval({
  tags: ["real-model"],
  description:
    "An agent-shaped dist extension with a registry-style store layout loads and its tool runs.",
  async test(t) {
    await t.send({ message: "Call `gadget__gadget_echo` with message 'eve'. Report the output." });

    t.succeeded();
    t.calledTool("gadget__gadget_echo", {
      output: { message: "eve", reply: "gadget-reply:eve" },
    });
  },
});
