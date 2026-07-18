import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description:
    "Fetch a customer record by account number. Requires one-time session approval before accessing PII.",
  inputSchema: z.object({
    account_number: z.string(),
  }),
  approval: once(),
  async execute(input) {
    return {
      account_number: input.account_number,
      name: "Alex Rivera",
      kyc_tier: 2,
      identity_verified: true,
    };
  },
});
