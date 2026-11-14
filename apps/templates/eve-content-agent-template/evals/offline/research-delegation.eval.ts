import { defineEval } from "eve/evals";
import { asRecord, toolScript } from "../shared.js";

/**
 * The `research` tool sends the depth-prefixed message to the researcher and returns its result.
 *
 * @remarks
 * The mocked researcher echoes the message it received as `summary`, which shows what the tool
 * sent, including the `Research depth:` line the model router reads.
 */
export default defineEval({
  description:
    "research prefixes the depth and returns the researcher's structured result.",
  async test(t) {
    await t.send(
      toolScript("research", {
        depth: "deep",
        message: "How does QUIC handle loss?",
      })
    );
    t.succeeded();
    t.calledTool("research", {
      output: (value) => {
        const { summary } = asRecord(value);
        return (
          typeof summary === "string" &&
          summary.includes("Research depth: deep\n\nHow does QUIC handle loss?")
        );
      },
    });
  },
});
