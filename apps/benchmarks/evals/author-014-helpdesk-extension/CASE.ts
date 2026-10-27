import { defineAuthoringCase, simpleProject } from "../../lib/authoring-case.js";
import { helpdeskExtensionSetup } from "../../lib/setups/helpdesk-extension.js";

// Mounting an extension another team owns, then adapting it from the consuming agent:
// overriding one tool, removing another, and reporting a third's results.
export default defineAuthoringCase({
  startingPoint: simpleProject,
  setup: helpdeskExtensionSetup,
  async interact({ send }) {
    await send(
      [
        "This agent handles customer support at Northwind. The platform team ships our helpdesk integration as the `@northwind/helpdesk` eve extension. It's already a dependency of this project, with its source in `packages/helpdesk/`. Other agents use the package too, so don't change it; make every change in this agent.",
        "",
        "- Mount it as `helpdesk`, working with the `support` queue and the API token in `HELPDESK_TOKEN`, which is already set in `.env.local`.",
        "- Closing a ticket emails the customer, so in this agent `close_ticket` must ask for approval before it runs.",
        "- This agent must never be able to delete tickets.",
        '- Our dashboard counts new tickets. Whenever this agent creates a ticket, POST `{ "ticketId": <id>, "queue": <queue> }` as JSON to `https://dash.northwind.dev/v1/new-tickets`. The dashboard is best effort: an outage must never get in the way of helping the customer.',
        "",
        "Make sure the project typechecks and builds.",
      ].join("\n"),
    );
  },
});
