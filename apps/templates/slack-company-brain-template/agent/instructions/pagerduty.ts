import { connectorSetupNote } from "../lib/connect.ts";

// Tells the agent how to point people to PagerDuty setup until the
// `pagerduty/company-brain` connector is attached. Delete this file to drop
// the note; it says nothing once PagerDuty is connected.
export default connectorSetupNote({
  label: "PagerDuty",
  service: "pagerduty",
  connectionMethod: "mcp",
  createFlags: "--data @pagerduty.json",
  what: "incidents, services, and on-call schedules",
  file: "agent/instructions/pagerduty.ts",
  beforeCreate: [
    'A PagerDuty admin registers an OAuth app under Integrations > Developer Tools > App Registration, and saves its client ID and secret as `pagerduty.json`: `{ "clientId": "…", "clientSecret": "…" }`.',
  ],
  perPerson: true,
});
