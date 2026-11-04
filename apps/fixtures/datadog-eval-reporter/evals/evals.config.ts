import { defineEvalConfig } from "eve/evals";
import { datadogReporter } from "eve/evals/reporters";

const hasDatadogCredentials = Boolean(process.env.DD_API_KEY && process.env.DD_APP_KEY);

export default defineEvalConfig({
  reporters: hasDatadogCredentials ? [datadogReporter({ recordInputs: true })] : [],
});
