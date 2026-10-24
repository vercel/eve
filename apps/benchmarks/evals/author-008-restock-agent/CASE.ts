import { defineAuthoringCase, emptyProject } from "../../lib/authoring-case.js";
import { northstarFulfillmentSetup } from "../../lib/setups/northstar-fulfillment.js";

export default defineAuthoringCase({
  startingPoint: emptyProject,
  projectDirectory: "restock-agent",
  setup: northstarFulfillmentSetup,
  async interact({ send }) {
    await send(
      [
        "Build me an eve agent in a new `restock-agent` project. It's called Restock, and it helps the Northstar Fulfillment warehouse team keep inventory stocked from Slack.",
        "",
        "- The team talks to it in Slack. There's no Vercel Connect here, so use Slack credentials from the `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` environment variables.",
        "- It reads inventory through the Northstar API. The API team's OpenAPI contract is in `northstar-openapi.json` next to the project; the base URL is `https://api.northstar-fulfillment.com` and it takes a bearer token from `NORTHSTAR_API_TOKEN`. The model should only be able to discover the read-only `getStock` and `listLowStock` operations.",
        "- It can place purchase orders with a `create_purchase_order` tool that takes `sku`, `quantity` (a positive integer), and `unitCostUsd` (a positive number), POSTs them as JSON to `/purchase-orders` on that API with the same token, and returns the created order. Orders totaling $5,000 or more must wait for a person to approve them; smaller orders go through on their own.",
        "- Every weekday at 13:00 UTC it posts a low-stock digest to the Slack channel `C0RESTOCK1`.",
        "- It follows the warehouse restocking playbook, which the model should load only when it is deciding what to reorder: reorder up to twice the SKU's par level, never reorder discontinued SKUs, and flag any single order over $20,000 to the ops lead instead of placing it.",
        "",
        "Make sure the project typechecks and builds.",
      ].join("\n"),
    );
  },
});
