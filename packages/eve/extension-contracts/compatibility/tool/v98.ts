// Epoch 98 sandbox providers end a session from `reason` alone; epoch 99 also
// passes the build's prepared artifact, which they may ignore.
import { defineSandboxProvider } from "#public/sandbox/provider.js";
import { defineTool } from "#public/tools/index.js";

const environment = defineSandboxProvider<
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
}).environment();

export default defineTool({
  description: "List the workspace.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox(environment);
    return (await sandbox.run({ command: "ls" })).stdout;
  },
});
