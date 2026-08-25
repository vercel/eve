import { defineAgent } from "#public/definitions/agent.js";
import { DEFAULT_AGENT_MODEL_ID } from "#shared/default-agent-model.js";

/**
 * Framework default agent configuration, applied when an app does not author
 * an `agent.ts` config value of its own.
 */
export default defineAgent({ model: DEFAULT_AGENT_MODEL_ID });
