import { catalogTool } from "../lib/catalog";

/** Lets the agent drag one page element onto another. Deferred: the agent finds it with tool search. */
export default catalogTool("drag", { deferred: true });
