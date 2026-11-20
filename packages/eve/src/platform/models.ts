import type { PlatformModels } from "#platform/types.js";
import { vercelModels } from "#platform/vercel/models.js";

export function platformModels(): PlatformModels {
  return vercelModels;
}
