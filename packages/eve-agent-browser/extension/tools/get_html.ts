import { catalogTool } from "../lib/catalog";

/** Lets the agent read the inner HTML of a page element. Deferred: the agent finds it with tool search. */
export default catalogTool("get_html", { deferred: true });
