import { catalogTool } from "../lib/catalog";

/** Lets the agent read the page's console logs. Deferred: the agent finds it with tool search. */
export default catalogTool("console", { deferred: true });
