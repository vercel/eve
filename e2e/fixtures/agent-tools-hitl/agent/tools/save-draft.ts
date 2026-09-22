import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";

const writes = defineState("draft.writes", () => 0);

export default defineTool({
  description: "Save the fixture draft and return the number of writes in this session.",
  inputSchema: z.object({}),
  async execute() {
    writes.update((count) => count + 1);
    return { writes: writes.get() };
  },
});
