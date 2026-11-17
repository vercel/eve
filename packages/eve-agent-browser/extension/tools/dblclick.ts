import { catalogTool } from "../lib/catalog";

/** Lets the agent double-click a page element. Deferred: the agent finds it with tool search. */
export default catalogTool("dblclick", { deferred: true });
