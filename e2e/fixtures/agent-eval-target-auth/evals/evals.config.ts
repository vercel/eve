import { defineEvalConfig } from "eve/evals";

import { mintToken } from "./token.js";

export default defineEvalConfig({
  targetAuth: { bearer: () => mintToken() },
});
