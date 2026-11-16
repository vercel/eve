import { defineAgent } from "eve";
import { MOCK_MODELS, SCRIPTED_MODEL } from "./lib/mock-model.js";
import { ROOT_MODEL } from "./lib/models.js";

/**
 * Root agent runtime configuration.
 *
 * @remarks
 * Sets the language model for the content assistant. The rest of the agent's surface
 * (channels, connections, tools, skills, memory) is discovered from the filesystem under
 * `agent/`. Under {@link MOCK_MODELS} the model is a scripted mock for the offline evals.
 */
export default defineAgent({
  model: MOCK_MODELS ? SCRIPTED_MODEL : ROOT_MODEL,
});
