import { defineAuthoringCase, simpleProject } from "../../lib/authoring-case.js";
import { helpdeskExtensionSetup } from "../../lib/setups/helpdesk-extension.js";

// Mounting an extension another team owns, then adapting it from the consuming agent:
// overriding one tool, removing another, and reporting a third's results. The prompt calls it
// a package; only its own metadata and README say it is an eve extension.
export default defineAuthoringCase({
  startingPoint: simpleProject,
  setup: helpdeskExtensionSetup,
  async interact({ send }) {
    await send(
      [
        "This agent is for Northwind's support team. The platform team maintains our helpdesk integration as the `@northwind/helpdesk` package. It's already a dependency here, with its source in `packages/helpdesk/`. Other agents rely on it, so please don't edit the package; make the changes in this agent.",
        "",
        "- Set it up for the `support` queue, with the helpdesk token from `HELPDESK_TOKEN` (already set in `.env.local`).",
        "- Closing a ticket emails the customer, so in this agent a person has to sign off before any ticket gets closed.",
        "- This agent shouldn't be able to delete tickets at all.",
        '- We count new tickets on our ops dashboard. Every time the agent opens a ticket, POST `{ "ticketId": <id>, "queue": <queue> }` as JSON to `https://dash.northwind.dev/v1/new-tickets`. The dashboard is best effort; if it\'s down, the agent should still be able to help the customer.',
        "",
        "Make sure the project typechecks and builds.",
      ].join("\n"),
    );
  },
});
