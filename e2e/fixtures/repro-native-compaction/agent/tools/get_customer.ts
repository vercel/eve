import { defineTool } from "eve/tools";
import { z } from "zod";

import { CUSTOMERS } from "../data.js";

export default defineTool({
  description: "One customer's full record, including every order.",
  inputSchema: z.object({ customerId: z.string() }),
  async execute({ customerId }) {
    const customer = CUSTOMERS.find((entry) => entry.id === customerId);
    return customer ?? { error: `No customer ${customerId}` };
  },
});
