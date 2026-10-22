import { defineState } from "#public/context/index.js";
import { defineSandboxProvider } from "#public/sandbox/provider.js";

// Epoch 14 providers end a session from `reason` alone; epoch 15 also passes
// the build's prepared artifact, which they may ignore.
export const AcmeSandbox = defineSandboxProvider<
  undefined,
  undefined,
  { templateId: string },
  { name: string }
>({
  name: "acme",
  environment: () => ({
    async onSessionEnd(ctx, state, { reason }) {
      console.info("ending sandbox", state?.name ?? ctx.session.id, reason);
    },
    async prepare() {
      return { templateId: "acme-template" };
    },
    async resume() {
      throw new Error("Acme sandboxes cannot resume.");
    },
    async start() {
      throw new Error("Acme sandboxes cannot start.");
    },
  }),
});

export const endedSessions = defineState("compatibility.ended-sessions", () => ({ count: 0 }));
