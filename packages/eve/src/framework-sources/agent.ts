import { defineAgent } from "#public/definitions/agent.js";
import { DEFAULT_AGENT_MODEL_ID } from "#shared/default-agent-model.js";

export default Object.freeze(
  defineAgent({
    model: DEFAULT_AGENT_MODEL_ID,
  }),
);
