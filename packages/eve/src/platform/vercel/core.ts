import { definePlatform, type PlatformFields } from "#platform/declaration.js";
import { vercelDeployment } from "#platform/vercel/deployment.js";
import { vercelIdentity } from "#platform/vercel/identity.js";
import { vercelNetwork } from "#platform/vercel/network.js";

export function vercelSessionAttribute(): string | undefined {
  return process.env.VERCEL_ENV === undefined ? undefined : "vercel.session_id";
}

export const vercelCoreFields = {
  deployment: () => vercelDeployment,
  identity: () => vercelIdentity,
  network: () => vercelNetwork,
  telemetry: () => ({
    get sessionAttribute() {
      return vercelSessionAttribute();
    },
  }),
} satisfies PlatformFields<undefined>;

export const vercelCorePlatform = definePlatform(vercelCoreFields);
