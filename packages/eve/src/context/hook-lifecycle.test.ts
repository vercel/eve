import { expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { dispatchStreamEventHooks } from "#context/hook-lifecycle.js";
import { ChannelInstrumentationKey, SessionKey } from "#context/keys.js";
import { emptySessionView } from "#protocol/session-projection/fold.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { isChannel } from "#public/channels/index.js";
import { defineChannel } from "#public/definitions/channel.js";
import { setChannelInstrumentationKind, type CompiledChannel } from "#channel/compiled-channel.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";

it("matches an authored HTTP channel in hooks without changing its durable adapter kind", async () => {
  const support = defineChannel({ routes: [] });
  setChannelInstrumentationKind(support as CompiledChannel, "channel:support");
  const ctx = new ContextContainer();
  ctx.set(BundleKey, { turnAgent: { id: "support-agent" } } as CompiledBundle);
  ctx.set(ChannelKey, { kind: "http" });
  ctx.set(ChannelInstrumentationKey, { kind: "channel:support", metadata: {} });
  ctx.setVirtualContext(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId: "session_1",
    turn: { id: "turn_0", sequence: 0 },
  });
  let matched = false;
  await contextStorage.run(ctx, () =>
    dispatchStreamEventHooks({
      ctx,
      registry: {
        streamEventsByType: new Map(),
        streamEventsWildcard: [
          {
            slug: "notify-support",
            eventType: "*",
            handler(_event, hook) {
              matched = isChannel(hook.channel, support);
            },
          },
        ],
      },
      event: {
        type: "turn.settled",
        data: { turnId: "turn_0", outcome: "completed" },
        scope: { turnId: "turn_0" },
      } as SessionStreamEvent,
      position: { line: 1, index: 0 },
      progress: false,
      view: emptySessionView(),
      cancelTurn: undefined,
    }),
  );
  expect(matched).toBe(true);
  expect(ctx.require(ChannelKey).kind).toBe("http");
});
