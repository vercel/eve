import { defineTool } from "eve/tools";
import { auto } from "eve/tools/approval";

import { permissionDecisionModel } from "../testing";

export default defineTool({
  description: "Exercise decision-model approval.",
  inputSchema: {
    type: "object",
    properties: { effect: { type: "string", enum: ["safe", "malicious"] } },
    required: ["effect"],
    additionalProperties: false,
  },
  approval: auto({ model: permissionDecisionModel }),
  execute({ effect }) {
    return { effect, executed: true };
  },
});
