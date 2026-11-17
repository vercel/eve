import { defineExtension } from "eve/extension";

/** Adds the `computer_use` tool to an agent, which drives a Linux desktop inside the sandbox. Mount it only for agents whose sandbox runs the desktop. */
export default defineExtension();
