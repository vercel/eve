import { definePlatform } from "eve/experimental/platform";

import { PLATFORM_NOTE } from "./constants.js";
import { platformDocuments } from "./lib/platform-documents.js";

export default definePlatform({
  context: async () => ({ note: PLATFORM_NOTE }),
  deployment: () => ({
    environment: () => "development",
    deploymentId: () => undefined,
    host: () => undefined,
    scope: () => undefined,
  }),
  storage: (_app, context) => ({ documents: platformDocuments(context.note) }),
});
