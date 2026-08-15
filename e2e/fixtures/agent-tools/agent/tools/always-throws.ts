import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

/**
 * Smoke-test fixture: a tool whose `execute` always throws synchronously.
 *
 * Used by `evals/static-tools/throw-recover.eval.ts` to assert that an authored
 * tool throw surfaces on the stream as `action.result` with
 * `isError: true` (the AI SDK catches the throw and synthesises a
 * tool-error result), the harness does NOT emit `turn.failed`, and the
 * session remains usable for a follow-up message.
 *
 * `approval: never()` keeps the test single-turn from a HITL
 * perspective so the throw path is the only thing under test.
 */
export default defineTool({
  description:
    "Smoke-test fixture: always throws. Only call when the user explicitly asks to call `always-throws`.",
  inputSchema: z.object({
    reason: z.string().describe("Free-form reason for the call. The tool ignores it and throws."),
  }),
  approval: never(),
  async execute(_input) {
    throw new Error("always-throws: intentional failure for smoke-test coverage");
  },
});
