import { createActiveStepAbortController } from "#compiled/@workflow/core/index.js";
import { turnCancellationHookToken } from "#execution/turn-cancellation-token.js";

/**
 * Owns one turn's cancellation surface inside the turn workflow: the
 * turn-private cancel hook and the durable controller whose
 * signal is serialized into every `turnStep`. Must be created inside a
 * `"use workflow"` body.
 */
export interface TurnCancellationControl {
  /** Turn signal to serialize into each `turnStep` input. */
  readonly signal: AbortSignal;
  /**
   * Resolves `"cancel"` once a matching cancel payload is consumed and
   * the signal aborted. Race it against turn-owned awaits — never
   * `await` it alone.
   */
  readonly requested: Promise<"cancel">;
  /** Disposes the internal hook. Idempotent. */
  dispose(): void;
}

/**
 * Creates the private, stream-backed cancel controller for one turn workflow
 * run. `resumeHook()` writes this controller's signal stream before the
 * workflow replay that settles the cancellation.
 */
export function createTurnCancellationControl(input: {
  readonly controlToken: string;
}): TurnCancellationControl {
  const controller = createActiveStepAbortController({
    token: turnCancellationHookToken(input.controlToken),
  });
  const requested = new Promise<"cancel">((resolve) => {
    if (controller.signal.aborted) {
      resolve("cancel");
      return;
    }
    controller.signal.addEventListener("abort", () => resolve("cancel"), { once: true });
  });
  let disposed = false;
  return {
    signal: controller.signal,
    requested,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      controller.dispose();
    },
  };
}
