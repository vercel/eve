import { catalogTool } from "../lib/catalog";

/** Lets the agent hover the pointer over a page element. Deferred: the agent finds it with tool search. */
export default catalogTool("hover", { deferred: true });
