import { defineState } from "eve/context";

export const actionNarrationObservation = defineState<string | null>(
  "agent-tools.actionNarrationObservation",
  () => null,
);
