import {
  createComputeAuthenticator,
  createComputeGatewayServer,
  createComputeHttpHandler,
  createPostgresStorage,
  loadComputeAccessFile,
  type ComputeGatewayServer,
} from "eve/internal/compute-platform";

import { localAccessFilePath } from "./access.ts";
import { computePlatformConfig } from "./config.ts";

export async function startLocalComputeGateway(): Promise<{
  server: ComputeGatewayServer;
  url: string;
}> {
  const storage = createPostgresStorage({
    applicationName: "eve-compute-local-gateway",
    connectionString: computePlatformConfig.runtimeUrl,
    maxConnections: 16,
  });
  const server = createComputeGatewayServer(
    createComputeHttpHandler({
      authenticator: createComputeAuthenticator(await loadComputeAccessFile(localAccessFilePath)),
      storage,
    }),
  );
  const target = new URL(computePlatformConfig.endpoint);
  if (target.protocol !== "http:" || target.pathname !== "/" || target.search || target.hash) {
    await storage.close();
    throw new Error("EVE_COMPUTE_ENDPOINT must be an HTTP origin without a path.");
  }
  const port = target.port === "" ? 80 : Number(target.port);
  try {
    const url = await server.listen(port, target.hostname);
    return {
      url,
      server: {
        listen: server.listen,
        async close() {
          await server.close();
          await storage.close();
        },
      },
    };
  } catch (error) {
    await storage.close();
    throw error;
  }
}
