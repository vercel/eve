import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { ACP_MAX_LINE_BYTES } from "#acp/line-limit.js";
import { runAcpServerOnStreams } from "#acp/server.js";
import type { SendTurnInput } from "#client/types.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  return { input, output };
}

describe("runAcpServerOnStreams", () => {
  it("terminates the connection when an ACP line exceeds the transport limit", async () => {
    const transport = streams();
    const server = runAcpServerOnStreams(
      { eveVersion: "1.2.3", serverUrl: "http://127.0.0.1:2000" },
      transport,
    );

    transport.input.end("x".repeat(ACP_MAX_LINE_BYTES + 1));

    await expect(server).resolves.toBeUndefined();
  });

  it("closes the transport without creating an eve session before the first prompt", async () => {
    const reset = vi.fn(async () => ({ status: "reset" }));
    const session = {
      cancel: vi.fn(async () => ({ status: "accepted" })),
      reset,
      respond: vi.fn(async () => emptyEvents()),
      send: vi.fn(async (_message: SendTurnInput["message"]) => emptyEvents()),
    };
    const client = {
      sessions: {
        async create(input: SendTurnInput) {
          return { response: await session.send(input.message), session };
        },
      },
    };
    const controller = new AbortController();
    const transport = streams();
    let output = "";
    let receivedSession = false;
    transport.output.on("data", (chunk: Buffer) => {
      output += chunk;
      if (output.includes('"id":2')) receivedSession = true;
    });

    const server = runAcpServerOnStreams(
      {
        client,
        eveVersion: "1.2.3",
        serverUrl: "http://127.0.0.1:2000",
        signal: controller.signal,
      },
      transport,
    );
    transport.input.write(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}\n',
    );
    transport.input.write(
      '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/","mcpServers":[]}}\n',
    );

    await vi.waitFor(() => expect(receivedSession).toBe(true));
    controller.abort();

    await expect(server).resolves.toBeUndefined();
    expect(reset).not.toHaveBeenCalled();
  });
});

async function* emptyEvents(): AsyncIterable<HandleMessageStreamEvent> {}
