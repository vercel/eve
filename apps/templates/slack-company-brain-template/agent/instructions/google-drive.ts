import { connectorSetupNote } from "../lib/connect.ts";

// Tells the agent how to point people to Google Drive setup until the
// `google-drive/company-brain` connector is attached. Delete this file to drop
// the note; it says nothing once Google Drive is connected.
export default connectorSetupNote({
  label: "Google Drive",
  service: "google-drive",
  connectionMethod: "google-child",
  what: "Docs, Sheets, Slides, and other files",
  file: "agent/instructions/google-drive.ts",
  perPerson: true,
});
