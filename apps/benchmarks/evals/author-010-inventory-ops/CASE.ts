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
        "- The team talks to it in Slack through our Vercel Connect connector `slack/restock`.",
        "- It works with inventory and purchasing through the Northstar API. The API team's OpenAPI contract is in `northstar-openapi.json` next to the project; it isn't published anywhere. The base URL is `https://api.northstar-fulfillment.com`, and the agent authenticates as itself with a bearer token from `NORTHSTAR_API_TOKEN`. Add it as a connection named `northstar`. The model may look up stock, list low-stock SKUs, and create purchase orders, but must never be able to adjust stock counts.",
        "- Purchase orders totaling $5,000 or more (quantity times unit cost) must wait for a person to approve them. Smaller orders and lookups go through on their own.",
        '- Northstar\'s warehouse system sends low-stock alerts to `POST /webhooks/low-stock` with a JSON body like `{ "sku": "NS-1042", "onHand": 3, "parLevel": 40 }`. Each request carries an `x-northstar-signature` header: the hex HMAC-SHA256 of the raw body, keyed with `NORTHSTAR_WEBHOOK_SECRET`. Reject anything else with a 401 without involving the agent. For a valid alert, Restock should pick up the alert in the Slack channel `C0RESTOCK1`, so the team sees it and can follow up in that thread.',
        "- Restock remembers what the team tells it about suppliers, such as lead times and minimum order quantities, across conversations. The whole team shares one supplier memory.",
        "",
        "Make sure the project typechecks and builds.",
      ].join("\n"),
    );
  },
});
