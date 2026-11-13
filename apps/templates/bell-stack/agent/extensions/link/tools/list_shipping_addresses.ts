import { list_shipping_addresses } from "@stripe/link-integrations-eve/tools";
import { defineTool } from "eve/tools";
import { freshLinkContext } from "../../../lib/link-auth";

export default defineTool({ ...list_shipping_addresses,
  execute: (input, ctx) => list_shipping_addresses.execute(input, freshLinkContext(ctx)),
});
