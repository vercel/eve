import { defineState } from "eve/context";

export interface InputHookObservation {
  readonly receiver: "channel" | "hook";
  readonly sessionId: string;
  readonly requestIds: readonly string[];
}

export const inputHookAudit = defineState<InputHookObservation[]>(
  "hitl-fixture.input-hook-audit",
  () => [],
);
