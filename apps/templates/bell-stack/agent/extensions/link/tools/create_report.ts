import { create_report } from "@stripe/link-integrations-eve/tools";
import { defineTool } from "eve/tools";
import { freshLinkContext } from "../../../lib/link-auth";

export default defineTool({ ...create_report,
  execute: (input, ctx) => create_report.execute(input, freshLinkContext(ctx, input.spend_request_id)),
});
