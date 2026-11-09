import { connectorSetupNote } from "../lib/connect.ts";

// Tells the agent how to point people to GitHub setup until the
// `github/company-brain` connector is attached. Delete this file to drop the
// note; it says nothing once GitHub is connected.
export default connectorSetupNote({
  label: "GitHub",
  service: "github",
  what: "repositories, issues, and pull requests, and `git__gh` commands fail, so don't run them",
  file: "agent/instructions/github.ts",
  afterCreate: [
    "Install the connector's GitHub App on the repositories the agent may use, from the Connect dashboard.",
  ],
});
