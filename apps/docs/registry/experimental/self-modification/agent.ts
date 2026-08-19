import { defineSelfModificationAgent } from "@eve/self-modification/agent";

/*
 * By default, inherits the parent agent's model.
 * Can explicitly set to a different model e.g. defineSelfModificationAgent({ model: "openai/gpt-5.6-terra" })
 */
export default defineSelfModificationAgent();
