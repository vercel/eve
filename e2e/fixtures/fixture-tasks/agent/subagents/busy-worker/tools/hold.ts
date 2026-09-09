import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Hold a continuation until approval, or briefly delay other fixture work.",
  inputSchema: z.object({ marker: z.enum(["HOLD", "EXCLUSIVITY"]) }),
  approval: ({ toolInput }) =>
    toolInput?.marker === "EXCLUSIVITY" ? "user-approval" : "not-applicable",
  execute: async ({ marker }) => {
    if (marker === "HOLD") await new Promise((resolve) => setTimeout(resolve, 5_000));
    return { marker, released: true };
  },
});
