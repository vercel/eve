import { randomUUID } from "node:crypto";

import { toolOutput, toolOutputPart, type ToolModelOutput } from "eve/tools";

import extension from "../extension";
import type { DesktopCall } from "./desktop";
import { DESKTOP_ROOT } from "./sandbox";

export interface ScreenshotOutput extends Record<string, unknown> {
  readonly path?: string;
  readonly width?: number;
  readonly height?: number;
  /** Data URL of the captured image, for channels/UIs to render inline and for the model. */
  readonly imageDataUrl?: string;
  /** Why an inline screenshot carried no pixels, when it should have. */
  readonly imageOmitted?: "too_large" | "unreadable";
}

const MAX_INLINE_SCREENSHOT_BYTES = 3 * 1024 * 1024;

export function screenshotPath(): string {
  return `${DESKTOP_ROOT}/screenshots/${randomUUID()}.png`;
}

/**
 * Replaces the sandbox file with a data URL when inline screenshots are on.
 * The file is deleted once its bytes are in the output, so captures don't pile
 * up in the sandbox; a capture this tool could not inline is left in place,
 * because its path is then the only way to reach it. Reading and deleting both
 * share the call's deadline, so a slow read cannot outlive the tool call.
 */
export async function inlineScreenshot(
  data: unknown,
  call: DesktopCall,
): Promise<ScreenshotOutput> {
  const output = { ...(data as ScreenshotOutput | null) };
  if (!extension.config.inlineScreenshots || output.path === undefined) return output;
  const { path, ...rest } = output;
  const sandbox = call.sandbox;
  let bytes: Uint8Array | null;
  try {
    bytes = await sandbox.readBinaryFile({ path, signal: call.signal });
  } catch {
    return { ...output, imageOmitted: "unreadable" };
  }
  if (bytes === null || bytes === undefined || bytes.length === 0)
    return { ...output, imageOmitted: "unreadable" };
  if (bytes.length > MAX_INLINE_SCREENSHOT_BYTES)
    return { ...rest, path, imageOmitted: "too_large" };
  try {
    await sandbox.removePath({ path, force: true, signal: call.signal });
  } catch {
    call.signal.throwIfAborted();
  }
  return {
    ...rest,
    imageDataUrl: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
  };
}

/** The model gets the pixels when they were captured inline, and never the sandbox path or the base64 as text. */
export function screenshotModelOutput(output: ScreenshotOutput): ToolModelOutput {
  const { imageDataUrl, path: _path, ...rest } = output;
  const size = `${rest.width ?? "?"}x${rest.height ?? "?"}`;
  const summary = `Screenshot ${size} captured.`;
  if (imageDataUrl !== undefined) {
    return toolOutput.content([
      toolOutputPart.text(summary),
      toolOutputPart.file(imageDataUrl.slice("data:image/png;base64,".length), {
        mediaType: "image/png",
      }),
    ]);
  }
  const note =
    rest.imageOmitted === undefined
      ? undefined
      : `Its pixels were not inlined (${rest.imageOmitted === "too_large" ? "larger than the 3 MiB inline limit" : "unreadable"}); read the window's text with get or snapshot instead.`;
  return toolOutput.json({ ...rest, screenshot: [summary, note].filter(Boolean).join(" ") });
}
