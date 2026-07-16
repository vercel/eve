import type { TurnSteeringPayload } from "#execution/turn-control-protocol.js";
import { createTurnHookInbox } from "#execution/turn-hook-inbox.js";

/** Owns the active turn's durable steering inbox and step-boundary signal. */
export interface TurnSteeringControl {
  readonly requested: Promise<TurnSteeringPayload>;
  readonly signal: AbortSignal;
  readonly token: string;
  accept(): Promise<TurnSteeringPayload>;
  dispose(): Promise<void>;
}

/** Creates the private, single-flight steering inbox for one active turn. */
export async function createTurnSteeringControl(token: string): Promise<TurnSteeringControl> {
  const inbox = await createTurnHookInbox<TurnSteeringPayload>({ conflict: "throw", token });

  let controller: AbortController;
  let requested: Promise<TurnSteeringPayload>;
  let disposed = false;

  const arm = (): void => {
    controller = new AbortController();
    requested = inbox.next().then((value) => {
      controller.abort();
      return value;
    });
  };
  arm();

  return {
    get requested() {
      return requested;
    },
    get signal() {
      return controller.signal;
    },
    token: inbox.token,
    async accept() {
      const value = await requested;
      arm();
      return value;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await inbox.dispose();
    },
  };
}
