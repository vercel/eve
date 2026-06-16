import { describe, expect, it } from "vitest";
import {
  createRuntimeAdapterRegistry,
  deserializeRuntimeAdapter,
} from "#runtime/channels/registry.js";
import type { ChannelAdapter } from "#channel/adapter.js";
import { SUBAGENT_ADAPTER_KIND } from "#execution/subagent-adapter.js";

describe("subagent adapter", () => {
  it("round-trips durable delegation metadata through the ChannelKey codec", async () => {
    const { ChannelKey } = await import("#runtime/sessions/runtime-context-keys.js");
    const codec = ChannelKey.codec;

    if (codec === undefined) {
      throw new Error("codec missing");
    }

    const adapter: ChannelAdapter = {
      kind: SUBAGENT_ADAPTER_KIND,
      state: {
        callId: "call-9",
        parentContinuationToken: "subagent:parent",
        parentSessionId: "parent-session",
        subagentName: "summarizer",
      },
    };
    const serialized = codec.serialize(adapter);

    expect(serialized).toEqual({
      kind: SUBAGENT_ADAPTER_KIND,
      state: {
        callId: "call-9",
        parentContinuationToken: "subagent:parent",
        parentSessionId: "parent-session",
        subagentName: "summarizer",
      },
    });

    const rehydrated = deserializeRuntimeAdapter(
      createRuntimeAdapterRegistry({ channels: [] }),
      serialized,
    );

    expect(rehydrated.state).toEqual({
      callId: "call-9",
      parentContinuationToken: "subagent:parent",
      parentSessionId: "parent-session",
      subagentName: "summarizer",
    });
  });
});
