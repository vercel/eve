import { defineAgent } from "#public/definitions/agent.js";
import { DEFAULT_AGENT_MODEL_ID, DEFAULT_AGENT_REASONING } from "#shared/default-agent-model.js";

export default defineAgent({ model: DEFAULT_AGENT_MODEL_ID, reasoning: DEFAULT_AGENT_REASONING });
