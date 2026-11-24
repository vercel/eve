import { createVercelPlatformContext } from "#platform/vercel/context.js";
import { eveRuntime } from "#runtime/eve-runtime.js";

eveRuntime().platform = createVercelPlatformContext();
