import { list_payment_methods } from "@stripe/link-integrations-eve/tools";
import { defineTool } from "eve/tools";
import { freshLinkContext } from "../../../lib/link-auth";

export default defineTool({ ...list_payment_methods,
  execute: (input, ctx) => list_payment_methods.execute(input, freshLinkContext(ctx)),
});
