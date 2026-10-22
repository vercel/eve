// Epoch 49 sandbox providers end a session from `reason` alone; epoch 50 also
// passes the build's prepared artifact, which they may ignore.
import { defineHook } from "#public/hooks/index.js";
import { defineSandboxProvider } from "#public/sandbox/provider.js";

const AcmeSandbox = defineSandboxProvider<
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

export const environment = AcmeSandbox.environment();

export default defineHook({
  events: {
    "turn.started"() {
      console.info("turn started");
    },
  },
});
