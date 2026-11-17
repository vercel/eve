import { catalogTool } from "../lib/catalog";

/** Lets the agent read an attribute of a page element. Deferred: the agent finds it with tool search. */
export default catalogTool("get_attr", { deferred: true });
