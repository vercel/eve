import { connectorSetupNote } from "../lib/connect.ts";

// Tells the agent how to point people to Linear setup until the
// `linear/company-brain` connector is attached. Delete this file to drop the
// note; it says nothing once Linear is connected.
export default connectorSetupNote({
  label: "Linear",
  service: "linear",
  connectionMethod: "mcp",
  what: "issues, projects, and cycles",
  file: "agent/instructions/linear.ts",
  perPerson: true,
});
