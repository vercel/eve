import { retrieve_user_info } from "@stripe/link-integrations-eve/tools";
import { defineTool } from "eve/tools";
import { freshLinkContext } from "../../../lib/link-auth";

export default defineTool({ ...retrieve_user_info,
  execute: (input, ctx) => retrieve_user_info.execute(input, freshLinkContext(ctx)),
});
