import extension from "../extension.ts";
import { defineGenerateVideoTool } from "../lib/tools.ts";

/** Generates videos from text prompts, frame images, or reference media using the configured video model and storage. */
export default defineGenerateVideoTool(() => extension.config);
