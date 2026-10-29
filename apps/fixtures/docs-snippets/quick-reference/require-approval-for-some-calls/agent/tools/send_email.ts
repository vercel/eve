import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Send an email.",
  inputSchema: z.object({ to: z.string().email(), subject: z.string(), body: z.string() }),
  // toolInput is undefined when the model's input doesn't parse, so ask a person.
  approval: ({ toolInput }) =>
    toolInput === undefined || !toolInput.to.endsWith("@example.com")
      ? "user-approval"
      : "not-applicable",
  async execute({ to, subject }) {
    return { sent: true, to, subject };
  },
});
