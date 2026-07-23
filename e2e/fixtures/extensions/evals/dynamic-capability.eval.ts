import { defineEval } from "eve/evals";

// Token built by the extension's shared `extension/lib/brand` stamp() helper.
const TOOLKIT_FORECAST_TOKEN = "toolkit-forecast-ok-9F4Q";

export default defineEval({
  description: "Dynamic tool authored inside an extension resolves and runs when mounted.",
  async test(t) {
    await t.send("Call the `toolkit__toolkit_forecast` tool and report the token it returned.");

    t.succeeded();
    t.calledTool("toolkit__toolkit_forecast", { output: { token: TOOLKIT_FORECAST_TOKEN } });
  },
});
