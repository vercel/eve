import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { defineState } from "eve/context";
import { z } from "zod";

const executions = defineState("change-a.executions", () => 0);

export default defineTool({
  description: "Apply fixture change A after approval.",
  inputSchema: z.object({}),
  approval: always(),
  async execute() {
    executions.update((count) => count + 1);
    return { change: "A", executions: executions.get() };
  },
});
