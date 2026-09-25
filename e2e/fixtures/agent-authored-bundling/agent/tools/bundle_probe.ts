import { defineTool } from "eve/tools";
import { z } from "zod";

import binaryAsset from "../../authored-assets/runtime.bin";
import rawText from "../../authored-assets/runtime.txt?raw";
import { SHARED_MODULE_MARKER } from "../../authored-assets/shared";

export default defineTool({
  description: "E2E bundling probe. Call only when the user sends AUTHORED-BUNDLING-PROBE.",
  inputSchema: z.object({}),
  execute() {
    return {
      binaryAsset,
      rawText,
      sharedModule: SHARED_MODULE_MARKER,
    };
  },
});
