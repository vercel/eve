import { defineState } from "eve/context";

import { initialPersonalContext } from "./private-context.ts";

/**
 * Whose private data this session read. Each session has its own, so a subagent's starts clean
 * and a parent learns what a child read only through the call that ran it.
 */
export const personal = defineState("private-context.personal", initialPersonalContext);
