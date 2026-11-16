import { z } from "zod";

import {
  inlineScreenshot,
  screenshotModelOutput,
  screenshotPath,
  type ScreenshotOutput,
} from "../lib/screenshot";
import { app, desktopTool, flag, windowId } from "../lib/tool";

const inputSchema = z.object({
  app,
  windowId,
  screen: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Display index from list_displays; omit app and windowId to capture it."),
});

export default desktopTool<typeof inputSchema, ScreenshotOutput>({
  description:
    "Take a PNG screenshot of one app window (app or windowId) or of the whole screen. A covered window fails with reason covered: focus it first.",
  inputSchema,
  argv: (input) => [
    "screenshot",
    ...flag("app", input.app),
    ...flag("window-id", input.windowId),
    ...flag("screen", input.screen),
    screenshotPath(),
  ],
  output: inlineScreenshot,
  toModelOutput: screenshotModelOutput,
});
