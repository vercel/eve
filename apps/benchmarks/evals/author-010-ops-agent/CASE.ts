import { defineAuthoringCase, emptyProject } from "../../lib/authoring-case.js";
import { northstarFulfillmentSetup } from "../../lib/setups/northstar-fulfillment.js";

// An operations agent from an empty workspace. Each requirement is graded by its
// own check, so a run that gets part of the agent right still scores partial credit.
export default defineAuthoringCase({
  startingPoint: emptyProject,
  projectDirectory: "restock-agent",
  setup: northstarFulfillmentSetup,
  timeoutSeconds: 1800,
  async interact({ send }) {
    await send(
      [
        "Build me an eve agent in a new `restock-agent` project. It's called Restock, and it helps the Northstar Fulfillment warehouse team keep inventory stocked.",
        "",
        "- The team talks to it in Slack. We already set up the Vercel Connect connector `slack/restock` for that.",
        "- It works with inventory and purchasing through our Northstar API. The API team gave us an OpenAPI contract, `northstar-openapi.json`, next to the project; it isn't published anywhere. The base URL is `https://api.northstar-fulfillment.com`, and Restock calls it as itself with the bearer token in `NORTHSTAR_API_TOKEN`. Restock can look up stock, list low-stock SKUs, and create purchase orders, but it must never be able to adjust stock counts.",
        "- Any purchase order of $5,000 or more (quantity times unit cost) needs a person to approve it first. Smaller orders and lookups can go straight through.",
        '- Northstar\'s warehouse system sends low-stock alerts to `POST /webhooks/low-stock` with a JSON body like `{ "sku": "NS-1042", "onHand": 3, "parLevel": 40 }`. Each request has an `x-northstar-signature` header with the hex HMAC-SHA256 of the raw body, keyed with `NORTHSTAR_WEBHOOK_SECRET`. Reject anything that doesn\'t verify with a 401, without involving Restock. For a valid alert, Restock should post about it in the Slack channel `C0RESTOCK1` so the team can follow up in that thread.',
        "- Restock should remember what the team tells it about suppliers, like lead times and minimum order quantities, across conversations. It's one shared memory for the whole team, not one per person.",
        "",
        "Make sure the project typechecks and builds.",
      ].join("\n"),
    );
  },
});
