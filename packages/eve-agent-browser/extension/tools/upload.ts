import { catalogTool } from "../lib/catalog";

/** Lets the agent upload files through a file input. Deferred: the agent finds it with tool search. */
export default catalogTool("upload", { deferred: true });
