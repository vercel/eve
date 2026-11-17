import { catalogTool } from "../lib/catalog";

/** Lets the agent list the network requests captured in the browser session. Deferred: the agent finds it with tool search. */
export default catalogTool("network_requests", { deferred: true });
