import { catalogTool } from "../lib/catalog";
import { inlineScreenshot, type ScreenshotOutput } from "../lib/screenshot";

export default catalogTool<ScreenshotOutput>("screenshot", {
  output: inlineScreenshot,
  toModelOutput(output) {
    const { imageDataUrl, ...rest } = output;
    if (imageDataUrl === undefined) {
      return { type: "json", value: rest };
    }
    const { path: _path, ...visible } = rest;
    return {
      type: "json",
      value: { ...visible, screenshot: "Captured and already displayed to the user." },
    };
  },
});
