import { get, screenshot, wait_for } from "@agent-browser/eve/tools";
import { defineTool, type ToolContext, type ToolDefinition } from "eve/tools";

import { startLiveIfAvailable } from "./live";

/**
 * What the live view shows after a call: an image of the screen, the page's URL for a browser,
 * and where its live stream runs. The model never sees it; see `withScreen`.
 */
export interface Screen {
  /** Which device the image is of: a browser page, or the whole Linux screen. */
  readonly device: "browser" | "desktop";
  readonly imageDataUrl: string;
  readonly url?: string;
  /**
   * The sandbox the device's live stream runs in, once it does. Not a credential: the web app's
   * /api/live route authorizes the viewer against the session before it connects.
   */
  readonly sandbox?: string;
}

type ToolWithExecute<TInput> = ToolDefinition<TInput, unknown> & {
  execute(input: TInput, ctx: ToolContext): Promise<unknown>;
};

/**
 * The same tool, with a `screen` the web app's live view draws after every call. eve keeps
 * session sandboxes private to the agent, so the screen travels to the UI in tool output.
 */
export function withScreen<TInput>(
  tool: ToolWithExecute<TInput>,
  capture: (ctx: ToolContext, output: unknown) => Promise<Screen | undefined>,
) {
  return defineTool<TInput, { readonly screen?: Screen }>({
    ...tool,
    // The wrapped output adds `screen`, so the tool's own output schema no longer describes it.
    outputSchema: undefined,
    async execute(input, ctx) {
      const output = await tool.execute(input, ctx);
      const screen = await capture(ctx, output).catch(() => undefined);
      return { ...(isObject(output) ? output : { result: output }), screen };
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
  const sandbox = await startLiveIfAvailable(ctx, "browser");
  return { device: "browser", imageDataUrl: shot.imageDataUrl, url: page?.url, sandbox };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
