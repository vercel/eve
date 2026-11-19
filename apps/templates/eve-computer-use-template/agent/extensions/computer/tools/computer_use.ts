import { computer_use } from "eve/extensions/computer-use/tools";
import { defineTool } from "eve/tools";

import { startLiveIfAvailable } from "../../../lib/live";
import { captureDesktop, desktopModelOutput, type DeviceOutput } from "../../../lib/screen";

type ComputerUseInput = Parameters<typeof computer_use.execute>[0];
type ComputerUseOutput = { readonly screenshot: string } & Record<string, unknown>;

/**
 * computer_use returns the sandbox path of a fresh screenshot. Read it once, so the model sees
 * the desktop without a separate read_file call and the live view can draw it. The desktop's
 * live stream starts first, and is reported as progress before the action runs.
 */
export default defineTool<ComputerUseInput, DeviceOutput & Record<string, unknown>>({
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
  async *execute(input, ctx) {
    const early = await startLiveIfAvailable(ctx, "desktop");
    if (early) yield { live: { device: "desktop" } };
    const output = (await computer_use.execute(input, ctx)) as ComputerUseOutput;
    if (!early) await startLiveIfAvailable(ctx, "desktop");
    yield { ...output, screen: await captureDesktop(ctx, output.screenshot) };
  },
  toModelOutput: desktopModelOutput,
});
