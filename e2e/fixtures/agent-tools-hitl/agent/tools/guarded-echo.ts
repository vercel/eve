import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";

/**
 * Deterministic HITL fixture: every call is gated by `once()` approval, so
 * the first invocation parks the turn and an approval grant persists for the
 * rest of the session while a denial does not.
 */
export default defineTool({
  description:
    "Smoke-test fixture gated by HITL approval. Echoes the note input. Only call when the user explicitly asks for `guarded-echo`.",
  inputSchema: z.object({
    note: z.string().optional().describe("Any note string."),
  }),
  approval: once(),
  async execute(input) {
    return {
      echoed: input.note ?? null,
      token: "guarded-echo-ok-T4Q9",
    };
  },
});
