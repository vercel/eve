import { defineClientTool } from "eve/tools";
import { z } from "zod";

/**
 * Authored override of the built-in `ask_question`, widened with a typed `ui`
 * payload. This is the exact shape that regressed in #203: as a plain
 * `defineTool` it was forced to carry an `execute`, so a parked call produced a
 * second `tool_result` for its `tool_use` id and the resumed turn was rejected
 * ("each tool_use must have a single result"). As a `defineClientTool` it has no
 * executor — the call parks for input and resolves to exactly one result.
 *
 * The schema is a strict superset of the built-in (prompt / options /
 * allowFreeform), so the existing `ask-question-select` eval keeps passing while
 * exercising the authored path.
 */
export default defineClientTool({
  description:
    "Ask the user a question and wait for their answer. Plain choice: prompt (+ options, allowFreeform). Rich input: set a typed `ui` payload to render a picker.",
  inputSchema: z.object({
    prompt: z.string(),
    options: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
    allowFreeform: z.boolean().optional(),
    ui: z.object({ kind: z.string() }).passthrough().optional(),
  }),
});
