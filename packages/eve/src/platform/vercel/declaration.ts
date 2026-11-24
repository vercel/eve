import { definePlatform } from "#platform/declaration.js";
import { vercelBuild } from "#platform/vercel/build.js";
import { vercelCompute } from "#platform/vercel/compute.js";
import { vercelCoreFields, vercelSessionAttribute } from "#platform/vercel/core.js";
import { vercelDefaultDocumentBackend } from "#platform/vercel/memory.js";
import { resolveGatewayModelCredential } from "#platform/vercel/model-auth/gateway-credential.js";
import { vercelRuntimeSpanProcessor } from "#platform/vercel/runtime-span-exporter.js";
import { vercelScheduleProvider } from "#platform/vercel/schedules/provider.js";

export const vercelPlatform = definePlatform({
  ...vercelCoreFields,
  telemetry: () => ({
    get sessionAttribute() {
      return vercelSessionAttribute();
    },
    spanProcessor: vercelRuntimeSpanProcessor,
  }),
  compute: vercelCompute,
  storage: () => ({
    get documents() {
      return vercelDefaultDocumentBackend();
    },
  }),
  triggers: () => ({
    get schedules() {
      return vercelScheduleProvider();
    },
  }),
  models: () => ({ resolve: resolveGatewayModelCredential }),
  build: vercelBuild,
});
