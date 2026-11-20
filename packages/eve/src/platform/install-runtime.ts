import { createVercelPlatformContext } from "#platform/vercel/context.js";
import { createEveRuntime, installEveRuntime } from "#runtime/eve-runtime.js";

installEveRuntime(createEveRuntime({ platform: createVercelPlatformContext() }));
