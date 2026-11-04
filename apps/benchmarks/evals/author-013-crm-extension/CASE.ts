import { defineAuthoringCase, simpleProject } from "../../lib/authoring-case.js";
import { crmLocalEnvSetup } from "../../lib/setups/crm-local-env.js";

// Writing an extension package and mounting it into the agent that ships beside it. The prompt
// asks for a shared package without naming extensions, so the docs have to lead there.
export default defineAuthoringCase({
  category: "features/extensions",
  startingPoint: simpleProject,
  setup: crmLocalEnvSetup,
  async interact({ send }) {
    await send(
      [
        "We're going to have several agents that work with Acme CRM, and I don't want each one re-implementing the integration. Build it once as a shared package, `@acme/crm` in `packages/crm/` of this repo, that any of our agents can add to pick up the CRM capabilities, and add it to this agent first.",
        "",
        "- Each agent brings its own Acme API key. Agents use our production API, `https://api.acme-crm.dev`, unless they set another base URL, since some teams point at our Acme sandbox instead. Call those settings `apiKey` and `baseUrl`. This agent's key is in `CRM_API_KEY`, already set in `.env.local`.",
        '- Agents need to look up a customer by email (`lookup_customer`) and add a note to a customer\'s record (`add_note`). From Acme\'s API docs: `GET /v1/customers?email=<email>` returns the customer, and `POST /v1/customers/<customerId>/notes` with the JSON body `{ "note": "..." }` adds a note. Both take `Authorization: Bearer <apiKey>`.',
        "- Notes go straight onto the customer's record, so a person has to approve every note before it's written, in any agent that uses the package.",
        "- Agents using it should always look the customer up before writing a note, so notes don't land on the wrong record.",
        "",
        "Make sure the project typechecks and builds.",
      ].join("\n"),
    );
  },
});
