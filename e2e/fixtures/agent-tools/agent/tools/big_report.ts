import { defineTool, offloadContent } from "eve/tools";
import { z } from "zod";

const BIG_REPORT_ROWS = 400;

/**
 * Smoke-test fixture: returns a result far over the 2,000-byte limit, so the
 * model gets the saved file's path instead of the rows.
 */
export default defineTool({
  description:
    "Smoke-test fixture: returns a large report of rows. Only call when the user explicitly asks to use `big_report`.",
  inputSchema: z.object({}),
  execute: async () => ({
    rows: Array.from({ length: BIG_REPORT_ROWS }, (_, index) => ({
      id: index,
      label: `row-${index}`,
    })),
  }),
  toModelOutput: offloadContent({ maxBytes: 2_000 }),
});
