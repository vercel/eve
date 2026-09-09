import { defineTool } from "eve/tools";

import { CATALOG_HANDOFF_MARKER } from "../../constants";

export default defineTool({
  description: "Record Alice's completed catalog review as handoff notes for Bob.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute() {
    return {
      // Keep completion evidence ahead of the transcript's tool-output prefix cap.
      completionMarker: CATALOG_HANDOFF_MARKER,
      completed: true,
      notes:
        "Alice reviewed the catalog names, prices, and availability. Bob can use these recorded findings for the team handoff. "
          .repeat(500)
          .slice(0, 52_000),
    };
  },
});
