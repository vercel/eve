import { defineSelfModificationAgent } from "eve/self-modification/agent";

import config from "./config";

export default defineSelfModificationAgent({
  config,

  // To use a specific model instead of eve's default, add:
  // model: "provider/model",
});
