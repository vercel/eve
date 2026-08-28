import { defineEvalConfig } from "eve/evals";
import { Datadog } from "eve/evals/reporters";

const hasDatadogCredentials = Boolean(process.env.DD_API_KEY) && Boolean(process.env.DD_APP_KEY);

export default defineEvalConfig({
  reporters: hasDatadogCredentials ? [Datadog()] : [],
});
