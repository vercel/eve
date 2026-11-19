import { catalogTool } from "../lib/catalog";
import { inlineScreenshot, type ScreenshotOutput } from "../lib/screenshot";

/** Lets the agent capture a screenshot of the page. Small images are shown to the user inline, and the model gets the capture metadata instead of the image data. */
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
