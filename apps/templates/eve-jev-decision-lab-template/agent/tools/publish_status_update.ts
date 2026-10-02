import { defineTool } from "eve/tools";
import { auto } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Publish a simulated external status update after risk-based approval.",
  inputSchema: z.object({
    audience: z.enum(["internal", "customers", "public"]),
    message: z.string().min(1).max(4_000),
  }),
  approval: auto({
    instructions:
      "Require human approval for customer-facing or public communication, and allow an internal draft when its effects are clear and reversible.",
    criteria: {
      clear: "An internal-only draft with no external effect.",
      caution: "Customer-facing, public, irreversible, or unclear communication.",
    },
  }),
  async execute({ audience, message }) {
    return {
      audience,
      message,
      status: "simulated",
      note: "No status update was published. This tool demonstrates Jev-based approval.",
    };
  },
});
