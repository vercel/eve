import { defineTool } from "eve/tools";
import { z } from "zod";
import { record, waitForBalances } from "../../src/audit";
import { dataset } from "../../src/data";

export default defineTool({
  description:
    "Read an account's current USD balance. Returns { accountId, cents }, with integer cents. Each account uses an independent service; an unavailable service throws an error. There is no batch endpoint.",
  inputSchema: z.object({ accountId: z.string() }),
  outputSchema: z.object({ accountId: z.string(), cents: z.number().int() }),
  async execute(input, ctx) {
    return record(ctx, input, async () => {
      const { accounts } = dataset(ctx.session.id);
      const account = accounts.find(({ id }) => id === input.accountId);
      if (!account) throw new Error("Unknown account");
      // A bounded barrier makes overlap observable without a machine-speed threshold.
      await waitForBalances(
        ctx,
        accounts.map(({ id }) => id),
      );
      if (!account.available) throw new Error(`Balance unavailable for ${account.id}`);
      return { accountId: account.id, cents: account.cents };
    });
  },
});
