import { agent } from "eve/tools/agent";

import { MODEL_AGENT_SELECTED_MODEL } from "../../constants";

export default agent({
  models: {
    [MODEL_AGENT_SELECTED_MODEL]: "The model the e2e probe selects for its root copy.",
  },
});
