import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  ...e2eSubagentConfig(),
  description:
    "Nested specialist contacted by warehouse_lookup to find the third entry's inventory item. The checklist coordinator assigns all entries through agent instead.",
});
