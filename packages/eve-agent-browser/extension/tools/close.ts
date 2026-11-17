import { catalogTool } from "../lib/catalog";

/** Lets the agent close the current browser session. */
export default catalogTool("close", { hiddenArguments: ["all"] });
