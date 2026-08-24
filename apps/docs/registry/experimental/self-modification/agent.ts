import { defineSelfModificationAgent } from "@eve/self-modification/agent";

import config from "./config";

export default defineSelfModificationAgent({
  config,
  model: "openai/gpt-5.6-terra",
});
