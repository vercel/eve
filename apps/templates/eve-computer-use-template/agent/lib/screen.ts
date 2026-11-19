import { get, screenshot, wait_for } from "@agent-browser/eve/tools";
import {
  defineTool,
  toolOutput,
  toolOutputPart,
  type ToolContext,
  type ToolDefinition,
} from "eve/tools";

import { startLiveIfAvailable } from "./live";
import type { LiveDevice } from "./live-config";

/**
 * What the live view shows after a call: an image of the screen, and the page's URL for a
 * browser. The model never sees it; see `withScreen`.
 */
export interface Screen {
  /** Which device the image is of: a browser page, or the whole Linux screen. */
  readonly device: "browser" | "desktop";
  readonly imageDataUrl: string;
  readonly url?: string;
}

/**
 * That a device's live stream runs, yielded as progress before the device acts, so the live view
 * connects while the first action is still running.
 */
export interface LiveStart {
  readonly device: LiveDevice;
}

/** What a device tool reports: `live` while it works, then its output with a `screen`. */
export interface DeviceOutput {
  readonly screen?: Screen;
  readonly live?: LiveStart;
}

type ToolWithExecute<TInput> = ToolDefinition<TInput, unknown> & {
  execute(input: TInput, ctx: ToolContext): unknown;
};

/**
 * The same browser tool, with a `screen` the web app's live view draws after every call. eve
 * keeps session sandboxes private to the agent, so the screen travels to the UI in tool output.
 * The browser's live stream starts first, and is reported as progress before the action runs.
 */
export function withScreen<TInput>(
  tool: ToolWithExecute<TInput>,
  capture: (ctx: ToolContext, output: unknown) => Promise<Screen | undefined>,
) {
  return defineTool<TInput, DeviceOutput>({
    ...tool,
    // The wrapped output adds `screen`, so the tool's own output schema no longer describes it.
    outputSchema: undefined,
    async *execute(input, ctx) {
      if (await startLiveIfAvailable(ctx, "browser")) yield { live: { device: "browser" } };
      const output = await tool.execute(input, ctx);
      const screen = await capture(ctx, output).catch(() => undefined);
      yield { ...(isObject(output) ? output : { result: output }), screen };
    },
    toModelOutput(output) {
      const { screen: _screen, ...rest } = output as { screen?: Screen } & Record<string, unknown>;
      return tool.toModelOutput ? tool.toModelOutput(rest) : { type: "json", value: rest as never };
    },
  });
}

/** The browser's page after an action, through the extension's own screenshot and get tools. */
export async function captureBrowser(ctx: ToolContext): Promise<Screen | undefined> {
  // A click or key press can start a navigation that hasn't painted yet. Give it a moment to
  // start, then wait briefly for it to load, so the screenshot matches the URL.
  await wait_for.execute({ timeMs: 300, timeoutMs: 3000 }, ctx);
  await wait_for.execute({ loadState: "load", timeoutMs: 3000 }, ctx);
  const shot = (await screenshot.execute({ annotate: false, fullPage: false }, ctx)) as {
    imageDataUrl?: string;
  };
  if (shot.imageDataUrl === undefined) return undefined;
  const page = (await Promise.resolve(get.execute({ property: "url" }, ctx)).catch(() => null)) as {
    url?: string;
  } | null;
  return { device: "browser", imageDataUrl: shot.imageDataUrl, url: page?.url };
}

/** The desktop after an action, from the PNG computer_use saved in the sandbox. */
export async function captureDesktop(
  ctx: ToolContext,
  screenshotPath: string,
): Promise<Screen | undefined> {
  const session = await ctx.getSandbox();
  const bytes = await Promise.resolve(session.readBinaryFile({ path: screenshotPath })).catch(
    () => null,
  );
  if (!bytes || bytes.length === 0) return undefined;
  return {
    device: "desktop",
    imageDataUrl: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
  };
}

/** A tool result for the model: its JSON, plus the desktop's screenshot when there is one. */
export function desktopModelOutput({
  screen,
  ...rest
}: { screen?: Screen } & Record<string, unknown>) {
  const summary = toolOutputPart.text(JSON.stringify(rest));
  if (screen === undefined) return toolOutput.content([summary]);
  const base64 = screen.imageDataUrl.slice(screen.imageDataUrl.indexOf(",") + 1);
  return toolOutput.content([summary, toolOutputPart.file(base64, { mediaType: "image/png" })]);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
