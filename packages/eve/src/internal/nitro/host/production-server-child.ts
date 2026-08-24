import { Server } from "node:net";
import { pathToFileURL } from "node:url";

import type { ProductionServerMessage } from "#internal/nitro/host/production-server-process.js";

interface ProductionServerChildInput {
  readonly serverEntry: string;
  readonly url: string;
}

function parseInput(): ProductionServerChildInput {
  const raw = process.argv[2];
  if (raw === undefined) throw new Error("Missing production server child input.");
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== "object") {
    throw new Error("Invalid production server child input.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.serverEntry !== "string" || typeof record.url !== "string") {
    throw new Error("Invalid production server child input.");
  }
  return { serverEntry: record.serverEntry, url: record.url };
}

function observeServerListen(port: number): { readonly ready: Promise<void>; restore(): void } {
  const originalListen = Server.prototype.listen;
  let restore = () => {
    Server.prototype.listen = originalListen;
  };
  const ready = new Promise<void>((resolve, reject) => {
    Server.prototype.listen = function (this: Server, ...args: unknown[]) {
      const first = args[0];
      const requestedPort =
        typeof first === "number"
          ? first
          : first !== null && typeof first === "object" && "port" in first
            ? Number((first as { port: unknown }).port)
            : undefined;
      if (requestedPort === port) {
        const onListening = () => {
          this.off("error", onError);
          restore();
          resolve();
        };
        const onError = (error: Error) => {
          this.off("listening", onListening);
          restore();
          reject(error);
        };
        this.once("listening", onListening);
        this.once("error", onError);
      }
      return Reflect.apply(originalListen, this, args);
    } as typeof Server.prototype.listen;
  });
  restore = () => {
    if (Server.prototype.listen !== originalListen) {
      Server.prototype.listen = originalListen;
    }
  };
  return { ready, restore };
}

function send(message: ProductionServerMessage): void {
  process.send?.(message);
}

try {
  const input = parseInput();
  const url = new URL(input.url);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const listening = observeServerListen(port);
  try {
    await import(pathToFileURL(input.serverEntry).href);
    await listening.ready;
  } finally {
    listening.restore();
  }
  send({ type: "eve:production-server:ready", version: 1 });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  send({ message, type: "eve:production-server:error", version: 1 });
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
