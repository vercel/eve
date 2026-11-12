import { defineState } from "eve/context";

import type { LoopState } from "./loops.ts";

/** The latest turn's recent calls and nudges. A call from a new turn starts it over. */
export const loops = defineState<LoopState | null>("loops", () => null);
