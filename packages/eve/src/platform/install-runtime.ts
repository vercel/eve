import { setPlatformContext } from "#platform/context.js";
import { createVercelPlatformContext } from "#platform/vercel/context.js";

setPlatformContext(createVercelPlatformContext());
