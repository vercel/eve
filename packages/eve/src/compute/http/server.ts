import { createServer, type Server } from "node:http";

import { createApp, eventHandler, toNodeListener } from "nitro/h3";

export interface ComputeGatewayServer {
  close(): Promise<void>;
  listen(port: number, hostname?: string): Promise<string>;
}

export function createComputeGatewayServer(
  handler: (request: Request) => Promise<Response>,
): ComputeGatewayServer {
  const app = createApp();
  app.use(eventHandler((event) => handler(event.req)));
  const server: Server = createServer(toNodeListener(app));

  return {
    async listen(port, hostname = "127.0.0.1") {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, hostname, resolve);
      });
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Compute gateway did not expose a TCP address.");
      }
      return `http://${hostname}:${address.port}`;
    },
    async close() {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
      });
    },
  };
}
