import { catalogTool } from "../lib/catalog";

/** Lets the agent count the page elements that match a selector. Deferred: the agent finds it with tool search. */
export default catalogTool("get_count", { deferred: true });
