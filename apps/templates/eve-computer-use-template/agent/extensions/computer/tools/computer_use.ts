import { computer_use } from "eve/extensions/computer-use/tools";
import { defineTool, toolOutput, toolOutputPart } from "eve/tools";

import { startLiveIfAvailable } from "../../../lib/live";
import type { Screen } from "../../../lib/screen";

type ComputerUseOutput = { readonly screenshot: string } & Record<string, unknown>;

/**
 * computer_use returns the sandbox path of a fresh screenshot. Read it once, so the model sees
 * the desktop without a separate read_file call and the live view can draw it.
 */
export default defineTool({
  description: computer_use.description,
  inputSchema: computer_use.inputSchema,
  approval: computer_use.approval,
  label: {
    start: ({ request }) => {
      const action = request.action.replaceAll("_", " ");
      const subject =
        "app" in request
          ? ` ${request.app}`
          : "text" in request
            ? ` “${request.text.slice(0, 40)}”`
            : "";
      return `${action.charAt(0).toUpperCase()}${action.slice(1)}${subject}`;
    },
  },
  async execute(input, ctx) {
    const output = (await computer_use.execute(input, ctx)) as ComputerUseOutput;
    const sandbox = await ctx.getSandbox();
    const bytes = await Promise.resolve(sandbox.readBinaryFile({ path: output.screenshot })).catch(
      () => null,
    );
    const liveSandbox = await startLiveIfAvailable(ctx, "desktop");
    const screen: Screen | undefined =
      bytes && bytes.length > 0
        ? {
            device: "desktop",
            imageDataUrl: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
            sandbox: liveSandbox,
          }
        : undefined;
    return { ...output, screen };
  },
  toModelOutput({ screen, ...rest }) {
    const summary = toolOutputPart.text(JSON.stringify(rest));
    if (screen === undefined) return toolOutput.content([summary]);
    const base64 = screen.imageDataUrl.slice(screen.imageDataUrl.indexOf(",") + 1);
    return toolOutput.content([summary, toolOutputPart.file(base64, { mediaType: "image/png" })]);
  },
});
