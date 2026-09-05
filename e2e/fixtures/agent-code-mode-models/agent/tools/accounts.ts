import { defineTool } from "eve/tools";
import { z } from "zod";
import { record } from "../../src/audit";
import { dataset } from "../../src/data";

export default defineTool({
  description:
    "List every account in the treasury portfolio. Returns an array of { id } objects. Use balances to read each account's current USD balance.",
  inputSchema: z.object({}),
  outputSchema: z.array(z.object({ id: z.string() })),
  async execute(input, ctx) {
    return record(ctx, input, () => dataset(ctx.session.id).accounts.map(({ id }) => ({ id })));
  },
});
