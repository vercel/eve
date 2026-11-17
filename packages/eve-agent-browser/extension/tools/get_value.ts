import { catalogTool } from "../lib/catalog";

/** Lets the agent read the current value of an input. Deferred: the agent finds it with tool search. */
export default catalogTool("get_value", { deferred: true });
