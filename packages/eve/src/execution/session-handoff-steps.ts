import { resumeHook } from "#internal/workflow/runtime.js";
import type { SessionOwnerActivation } from "#execution/session-handoff.js";

export async function signalSessionOwnerActivationStep(input: {
  readonly activation: SessionOwnerActivation;
  readonly token: string;
}): Promise<void> {
  "use step";
  await resumeHook(input.token, input.activation);
}

export async function signalSessionAnchorStep(input: {
  readonly result: { readonly output: unknown };
  readonly token: string;
}): Promise<void> {
  "use step";
  await resumeHook(input.token, input.result);
}
