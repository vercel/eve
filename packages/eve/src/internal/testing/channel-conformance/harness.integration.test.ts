import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, describe, expect, it } from "vitest";

import {
  type ClientDriver,
  PLAIN_TOOL,
  withChannelConversation,
} from "#internal/testing/channel-conformance/harness.js";
import { tuiDriver } from "#internal/testing/channel-conformance/tui-driver.js";

/**
 * An HTTP origin that forwards to whichever agent the current conversation serves, started by
 * the first conversation and kept for the rest, as a browser client keeps one page.
 */
function longLivedOrigin() {
  let target: string | undefined;
  let started: Promise<{ url: string; close(): Promise<void> }> | undefined;
  async function start() {
    const server = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? "/", target);
        const hasBody = request.method !== "GET" && request.method !== "HEAD";
        const upstream = await fetch(url, {
          body: hasBody ? await readBody(request) : undefined,
          headers: Object.entries(request.headers).flatMap(([name, value]) =>
            typeof value === "string" && !["connection", "host"].includes(name)
              ? [[name, value] as [string, string]]
              : [],
          ),
          method: request.method,
        });
        response.writeHead(
          upstream.status,
          Object.fromEntries(
            [...upstream.headers].filter(
              ([name]) => !["content-length", "transfer-encoding"].includes(name),
            ),
          ),
        );
        if (upstream.body !== null) {
          const reader = upstream.body.getReader();
          response.on("close", () => void reader.cancel().catch(() => {}));
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            response.write(value);
          }
        }
        response.end();
      })().catch((error: unknown) => {
        if (!response.headersSent) response.writeHead(500);
        response.end(String(error));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  }
  const tui = tuiDriver();
  const driver: ClientDriver = {
    ...tui,
    name: "tui behind one origin",
    async open(host, wait) {
      target = host;
      const origin = await (started ??= start());
      return await tui.open(origin.url, wait);
    },
    async dispose() {
      await (await started)?.close();
    },
  };
  return driver;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe("withChannelConversation", () => {
  const driver = longLivedOrigin();
  afterAll(() => driver.dispose?.());

  // The origin's server took the first conversation's async context when it started listening.
  // Every request it serves later must still reach the current conversation's agent.
  it.each(["workflow", "in-process"] as const)(
    "runs each conversation's own tools behind an origin that outlives it (%s)",
    async (host) => {
      for (const conversation of ["first", "second"]) {
        await withChannelConversation(
          driver,
          async (c) => {
            await c.say(`Use ${PLAIN_TOOL} to find the review notes, ${conversation}.`);
            await c.waitForShown(new RegExp(`Used ${PLAIN_TOOL} for .*${conversation}`, "su"));
            expect(c.runsOf(PLAIN_TOOL), `${PLAIN_TOOL} runs in the ${conversation}`).toBe(1);
          },
          { host },
        );
      }
    },
    60_000,
  );
});
