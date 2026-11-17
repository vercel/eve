import { catalogTool } from "../lib/catalog";

/** Lets the agent find an element with semantic locators and optionally act on it. Deferred: the agent finds it with tool search. */
export default catalogTool("find", { deferred: true });
