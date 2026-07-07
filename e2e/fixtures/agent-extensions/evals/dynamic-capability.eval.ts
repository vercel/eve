import { defineEval } from "eve/evals";

// A defineDynamic resolver authored inside the extension registers a forecast
// tool at session start; it resolves and runs once mounted. The tool the
// resolver produces is namespaced by the mount just like the extension's static
// tools, so it surfaces as toolkit__toolkit_forecast.
// The token is built by the extension's shared `ext/lib/brand` `stamp()` helper,
// imported by the forecast tool — so this eval also proves an extension's
// `ext/lib/` modules bundle into its tools.
const TOOLKIT_FORECAST_TOKEN = "toolkit-forecast-ok-9F4Q";

export default defineEval({
  description: "Dynamic tool authored inside an extension resolves and runs when mounted.",
  async test(t) {
    await t.send("Call the `toolkit__toolkit_forecast` tool and report the token it returned.");

    t.succeeded();
    t.calledTool("toolkit__toolkit_forecast", { output: { token: TOOLKIT_FORECAST_TOKEN } });
  },
});
