import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export const GUARDED_ECHO_OPENAI_TOKEN = "guarded-echo-openai-ok-R2D7";

/**
 * Deterministic HITL fixture matching #236's repro. It is an authored tool with
 * both a real `execute` and `always()` approval, so every call parks the
 * turn for a human decision.
 */
export default defineTool({
  description:
    "Smoke-test fixture gated by HITL approval. Echoes the note input. Only call when the user explicitly asks for `guarded-echo`.",
  inputSchema: z.object({
    note: z.string().optional().describe("Any note string."),
  }),
  approval: always(),
  async execute(input) {
    return {
      echoed: input.note ?? null,
      token: "guarded-echo-openai-ok-R2D7",
    };
  },
});
