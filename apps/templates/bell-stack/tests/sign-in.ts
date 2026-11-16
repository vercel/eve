import type { SignInChallenge } from "eve/events";
import type { ChannelAdapter } from "../node_modules/eve/dist/src/channel/adapter.js";
import {
  emptySessionView,
  foldLine,
} from "../node_modules/eve/dist/src/protocol/session-projection/fold.js";

export function signInFlow(adapter: ChannelAdapter, channel: object, signIn: SignInChallenge) {
  const view = emptySessionView();
  const interactionId = `sign-in:${signIn.name}`;
  const opened = {
    type: "interaction.opened" as const,
    data: {
      interactionId,
      subject: { turnId: "turn" },
      request: { kind: "sign-in" as const, prompt: "Connect your account.", signIn },
    },
  };
  const settled = {
    type: "interaction.settled" as const,
    data: { interactionId, outcome: "accepted" as const },
  };
  return {
    async open() {
      foldLine(view, { at: new Date().toISOString(), facts: [opened] }, 0);
      await adapter["interaction.opened"]!(opened, { ...channel, view } as never);
    },
    async settle() {
      foldLine(view, { at: new Date().toISOString(), facts: [settled] }, 1);
      await adapter["interaction.settled"]!(settled, { ...channel, view } as never);
    },
  };
}
