import { describe, expect, it } from "vitest";

import {
  CHANNEL_SENTINEL,
  setChannelInstrumentationKind,
  type CompiledChannel,
} from "#channel/compiled-channel.js";
import { isChannel, type InstrumentationChannel } from "#public/instrumentation/index.js";

type SupportMetadata = {
  readonly priority: "high";
  readonly queueId: string | null;
};

const supportChannel: CompiledChannel<undefined, Record<string, unknown>, SupportMetadata> = {
  __kind: CHANNEL_SENTINEL,
  adapter: { kind: "defineChannel" },
  routes: [
    {
      method: "POST",
      path: "/support",
      handler: async () => new Response("ok"),
    },
  ],
};

declare module "#public/channels/index.js" {
  interface ChannelMetadataMap {
    readonly "channel:is-channel-test": SupportMetadata;
  }

  interface ChannelReferenceMap {
    readonly "channel:is-channel-test": typeof supportChannel;
  }
}

describe("isChannel", () => {
  it("compares instrumentation input to the compiler-stamped channel identity", () => {
    setChannelInstrumentationKind(supportChannel, "channel:is-channel-test");

    const input: InstrumentationChannel = {
      kind: "channel:is-channel-test",
      metadata: {
        priority: "high",
        queueId: null,
      },
    };

    expect(isChannel(input, supportChannel)).toBe(true);

    if (isChannel(input, supportChannel)) {
      const queueId: string | null = input.metadata.queueId;
      const priority: "high" = input.metadata.priority;
      // @ts-expect-error isChannel narrows to the channel metadata projection only.
      void input.metadata.missing;

      expect(queueId).toBeNull();
      expect(priority).toBe("high");
    }
  });

  it("returns false when the instrumentation channel kind does not match", () => {
    setChannelInstrumentationKind(supportChannel, "channel:is-channel-test");

    expect(
      isChannel(
        {
          kind: "unknown",
          metadata: {},
        },
        supportChannel,
      ),
    ).toBe(false);
  });

  it("accepts the DynamicResolveContext.channel shape (optional kind)", () => {
    setChannelInstrumentationKind(supportChannel, "channel:is-channel-test");

    const resolveCtxChannel: {
      readonly kind?: string;
      readonly metadata?: Record<string, unknown>;
    } = { kind: "channel:is-channel-test", metadata: { priority: "high", queueId: null } };

    expect(isChannel(resolveCtxChannel, supportChannel)).toBe(true);
  });

  it("returns false for DynamicResolveContext.channel with undefined kind", () => {
    setChannelInstrumentationKind(supportChannel, "channel:is-channel-test");

    const noKind: { readonly kind?: string } = {};
    expect(isChannel(noKind, supportChannel)).toBe(false);
  });
});
