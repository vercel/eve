import { defineState } from "eve/context";

import { initialExposure } from "./taint.ts";

/**
 * This session's exposure. Each session has its own, so a subagent's starts clean and a parent
 * learns what a child read only through the call that ran it.
 */
export const exposure = defineState("taint.exposure", initialExposure);
