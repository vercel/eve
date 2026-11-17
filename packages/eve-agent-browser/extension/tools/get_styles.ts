import { catalogTool } from "../lib/catalog";

/** Lets the agent read the computed styles of a page element. Deferred: the agent finds it with tool search. */
export default catalogTool("get_styles", { deferred: true });
