import { describe, expect, it } from "vitest";

import { setChannelInstrumentationKind, type CompiledChannel } from "#channel/compiled-channel.js";
import { defineChannel, POST } from "#public/definitions/channel.js";
import { isChannel, type InstrumentationChannel } from "#public/instrumentation/index.js";

type SupportMetadata = {
  readonly priority: "high";
  readonly queueId: string | null;
};

function createSupportChannel() {
  return defineChannel({
    metadata: (): SupportMetadata => ({ priority: "high", queueId: null }),
    routes: [POST("/support", async () => new Response("ok"))],
  });
}

const supportChannel = createSupportChannel();

function stampSupportChannel(): void {
  setChannelInstrumentationKind(supportChannel as CompiledChannel, "channel:is-channel-test");
}

describe("isChannel", () => {
  it("compares instrumentation input to the compiler-stamped channel identity", () => {
    stampSupportChannel();

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
    stampSupportChannel();

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
    stampSupportChannel();

    const resolveCtxChannel: {
      readonly kind?: string;
      readonly metadata?: Record<string, unknown>;
    } = { kind: "channel:is-channel-test", metadata: { priority: "high", queueId: null } };

    expect(isChannel(resolveCtxChannel, supportChannel)).toBe(true);
  });

  it("recognizes a separately evaluated copy of the authored channel", () => {
    stampSupportChannel();
    const importedCopy = createSupportChannel();

    expect(
      isChannel(
        {
          kind: "channel:is-channel-test",
          metadata: { priority: "high", queueId: null },
        },
        importedCopy,
      ),
    ).toBe(true);
  });

  it("returns false for DynamicResolveContext.channel with undefined kind", () => {
    stampSupportChannel();

    const noKind: { readonly kind?: string } = {};
    expect(isChannel(noKind, supportChannel)).toBe(false);
  });
});
