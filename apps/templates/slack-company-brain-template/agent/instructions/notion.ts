import { connectorSetupNote } from "../lib/connect.ts";

// Tells the agent how to point people to Notion setup until the
// `notion/company-brain` connector is attached. Delete this file to drop the
// note; it says nothing once Notion is connected.
export default connectorSetupNote({
  label: "Notion",
  service: "notion",
  connectionMethod: "mcp",
  what: "pages and databases",
  file: "agent/instructions/notion.ts",
  perPerson: true,
});
