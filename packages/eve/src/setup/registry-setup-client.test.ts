import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createRegistrySetupClient, type RegistrySetupClient } from "./registry-setup-client.js";
import type { RegistrySetupChildMessage } from "./registry-setup-protocol.js";

class SetupProcessStub extends EventEmitter {
  connected = true;
  sent: RegistrySetupChildMessage[] = [];
  send = vi.fn((message: RegistrySetupChildMessage) => {
    this.sent.push(message);
    return true;
  });
  disconnect = vi.fn(() => {
    this.connected = false;
  });
}

const previousProtocol = process.env.EVE_SETUP_PROTOCOL;

afterEach(() => {
  if (previousProtocol === undefined) delete process.env.EVE_SETUP_PROTOCOL;
  else process.env.EVE_SETUP_PROTOCOL = previousProtocol;
});

function client(processStub: SetupProcessStub): RegistrySetupClient {
  process.env.EVE_SETUP_PROTOCOL = "1";
  const result = createRegistrySetupClient({
    process: processStub,
  });
  if (result === undefined) throw new Error("Expected a registry setup client.");
  return result;
}

describe("createRegistrySetupClient", () => {
  it("disconnects the IPC channel after reporting a terminal outcome", () => {
    const processStub = new SetupProcessStub();
    const setup = client(processStub);

    setup.complete({ facts: [{ label: "Connector", value: "linear/agent" }] });

    expect(processStub.sent.at(-1)).toEqual({
      type: "result",
      outcome: {
        kind: "completed",
        facts: [{ label: "Connector", value: "linear/agent" }],
      },
    });
    expect(processStub.disconnect).toHaveBeenCalledOnce();
    expect(processStub.listenerCount("message")).toBe(0);
  });

  it("reports only the first terminal outcome", () => {
    const processStub = new SetupProcessStub();
    const setup = client(processStub);

    setup.cancel();
    setup.complete();

    expect(processStub.sent.filter((message) => message.type === "result")).toEqual([
      { type: "result", outcome: { kind: "cancelled" } },
    ]);
    expect(processStub.disconnect).toHaveBeenCalledOnce();
  });
});
