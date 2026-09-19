import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import type config from "./evals.config.js";

export default defineEval<typeof config>({
  description: "Eval setup supplies environment values and a live resource to evals.",
  async test(t) {
    await t.require(t.context.resource.read(), equals("ready"));
    await t.require(process.env.EVE_E2E_SETUP_READY, equals("1"));
  },
});
