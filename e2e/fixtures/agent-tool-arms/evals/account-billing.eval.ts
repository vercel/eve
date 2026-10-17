import { measuredEval } from "./measure";
export default measuredEval(
  "account-billing",
  "Resolve Acme to its CRM account and look up its billing details for support.",
  ["index__resolve_account", "support__support_billing"],
);
