import { defineTool } from "eve/tools";
import { z } from "zod";

import binaryAsset from "../../authored-assets/runtime.bin";
import rawText from "../../authored-assets/runtime.txt?raw";
import { SHARED_MODULE_MARKER } from "../../authored-assets/shared";

const instrumentationReadyAtImport = globalThis.eveE2eInstrumentationReady === true;

export default defineTool({
  description: "E2E bundling probe. Call only when the user sends AUTHORED-BUNDLING-PROBE.",
  inputSchema: z.object({}),
  execute() {
    return {
      binaryAsset,
      instrumentationReadyAtImport,
      rawText,
      sharedModule: SHARED_MODULE_MARKER,
    };
  },
});
