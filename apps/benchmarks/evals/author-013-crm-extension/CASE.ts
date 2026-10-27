import { defineAuthoringCase, simpleProject } from "../../lib/authoring-case.js";
import { crmLocalEnvSetup } from "../../lib/setups/crm-local-env.js";

// Writing an extension package and mounting it into the agent that ships beside it.
export default defineAuthoringCase({
  startingPoint: simpleProject,
  setup: crmLocalEnvSetup,
  async interact({ send }) {
    await send(
      [
        "Several of our agents will need to work with Acme CRM, so build that integration once as an eve extension package and use it here first. Create the package as `@acme/crm` in `packages/crm/` inside this project, and mount it into this agent as `crm`.",
        "",
        "- Agents that mount it configure an `apiKey`, which is required, and can optionally set a `baseUrl`, which defaults to `https://api.acme-crm.dev`. This agent passes the key from `CRM_API_KEY`, which is already set in `.env.local`.",
        "- A `lookup_customer` tool takes an `email` and returns the JSON from `GET <baseUrl>/v1/customers?email=<email>`, sent with `Authorization: Bearer <apiKey>`.",
        '- An `add_note` tool takes a `customerId` and a `note` and POSTs `{ "note": <note> }` as JSON to `<baseUrl>/v1/customers/<customerId>/notes` with the same header. It writes to the CRM, so it must always ask for approval first, in every agent that mounts the package.',
        "- Every agent that mounts it should be told to look a customer up before adding a note to their record.",
        "",
        "Make sure the project typechecks and builds.",
      ].join("\n"),
    );
  },
});
