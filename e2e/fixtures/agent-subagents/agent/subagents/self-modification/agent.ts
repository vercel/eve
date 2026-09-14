import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineSelfModificationAgent } from "eve/self-modification/agent";

export default defineSelfModificationAgent({ model: e2eSubagentConfig().model });
