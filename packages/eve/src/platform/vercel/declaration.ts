import { definePlatform } from "#platform/declaration.js";
import { vercelBuild } from "#platform/vercel/build.js";
import { vercelCompute } from "#platform/vercel/compute.js";
import { vercelDeployment } from "#platform/vercel/deployment.js";
import { vercelIdentity } from "#platform/vercel/identity.js";
import { vercelDefaultDocumentBackend } from "#platform/vercel/memory.js";
import { resolveGatewayModelCredential } from "#platform/vercel/model-auth/gateway-credential.js";
import { vercelNetwork } from "#platform/vercel/network.js";
import { vercelRuntimeSpanProcessor } from "#platform/vercel/runtime-span-exporter.js";
import { vercelScheduleProvider } from "#platform/vercel/schedules/provider.js";

export default definePlatform({
  deployment: () => vercelDeployment,
  identity: () => vercelIdentity,
  network: () => vercelNetwork,
  telemetry: () => ({
    get sessionAttribute() {
      return process.env.VERCEL_ENV === undefined ? undefined : "vercel.session_id";
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
  models: (app) => ({
    resolve: (rejectedToken) => resolveGatewayModelCredential(app.platform.network, rejectedToken),
  }),
  build: vercelBuild,
});
