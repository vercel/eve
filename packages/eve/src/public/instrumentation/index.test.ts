import { describe, expect, it } from "vitest";

import { setChannelInstrumentationKind, type CompiledChannel } from "#channel/compiled-channel.js";
import { defineChannel, POST } from "#public/definitions/channel.js";
import { isChannel, type InstrumentationChannel } from "#public/channels/index.js";

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

  it.each(["default", "empty"])("keeps nonmatching %s metadata projections readable", (mode) => {
    const target =
      mode === "default"
        ? defineChannel({ routes: [] })
        : defineChannel({ routes: [], metadata: () => ({}) });
    setChannelInstrumentationKind(target as CompiledChannel, "channel:empty");
    const inspect = (input: InstrumentationChannel) => {
      if (isChannel(input, target)) return "matched";
      return input.kind;
    };
    expect(inspect({ kind: "unknown", metadata: {} })).toBe("unknown");
  });

  it("accepts deliberately limited channel projections", () => {
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

  it("returns false for a kind-only projection without a kind", () => {
    stampSupportChannel();

    const noKind: { readonly kind?: string } = {};
    expect(isChannel(noKind, supportChannel)).toBe(false);
    if (isChannel(noKind, supportChannel)) {
      // @ts-expect-error A kind-only projection cannot acquire metadata through a guard.
      void noKind.metadata;
    }
  });
});
