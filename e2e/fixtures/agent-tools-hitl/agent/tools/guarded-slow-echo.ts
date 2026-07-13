import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";

export const GUARDED_SLOW_ECHO_TOKEN = "guarded-slow-echo-ok-V7K2";

/**
 * HITL fixture for https://github.com/vercel/eve/issues/460. It is gated by
 * `once()` and deliberately slow. The issue's repro singles out a
 * non-trivial async `execute` as the trigger. The approved call's result
 * must survive the wait before history is rebuilt and replayed.
 */
export default defineTool({
  description:
    "Smoke-test fixture gated by HITL approval with a slow side effect. Echoes the note input after a delay. Only call when the user explicitly asks for `guarded-slow-echo`, and call it strictly one call at a time. Never issue a second call before the previous call's result has arrived.",
  inputSchema: z.object({
    note: z.string().optional().describe("Any note string."),
  }),
  approval: once(),
  async execute(input) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return {
      echoed: input.note ?? null,
      token: GUARDED_SLOW_ECHO_TOKEN,
    };
  },
});
