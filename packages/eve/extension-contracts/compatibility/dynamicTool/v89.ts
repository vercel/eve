// Epoch 89 sandbox providers end a session from `reason` alone; epoch 90 also
// passes the build's prepared artifact, which they may ignore.
import { defineDynamic, defineTool } from "#public/tools/index.js";
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

const environment = AcmeSandbox.environment();

export default defineDynamic({
  events: {
    "turn.started": () =>
      defineTool({
        description: "List the workspace.",
        inputSchema: { type: "object", properties: {} },
        async execute(_input, ctx) {
          const sandbox = await ctx.getSandbox(environment);
          return (await sandbox.run({ command: "ls" })).stdout;
        },
      }),
  },
});
