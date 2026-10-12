import { describe, expect, it, vi } from "vitest";

import type { ChannelEventOf } from "#public/definitions/channel.js";
import { composeSlackRenderers, defineSlackRenderer } from "#public/channels/slack/renderers.js";

/** The parts of a handler's context these renderers read. */
function context() {
  const thread = {
    postDirectMessage: vi.fn(async () => undefined),
    postEphemeral: vi.fn(async () => undefined),
  };
  return {
    channel: { slack: {}, state: { channelId: "C1", teamId: null, threadTs: "1.0" }, thread },
    position: { index: 0, line: 1 },
  };
}

/** Runs a composed chain's handler with the partial context above. */
async function invoke(handler: unknown, event: unknown): Promise<void> {
  await (handler as (event: unknown, ctx: unknown) => Promise<void>)(event, context());
}

const completed: ChannelEventOf<"content.completed"> = {
  data: { kind: "text", partId: "part_0", phase: "reply", runId: "run_0", value: "Done." },
  scope: { runId: "run_0", turnId: "turn_0" },
  type: "content.completed",
};

describe("composeSlackRenderers", () => {
  it("runs each renderer around the default with the event and its context", async () => {
    const calls: string[] = [];
    const fallback = vi.fn(async (event: ChannelEventOf<"content.completed">) => {
      calls.push(`default:${String(event.data.value)}`);
    });
    const chain = composeSlackRenderers(
      [
        defineSlackRenderer({
          events: {
            async "content.completed"(event, ctx, next) {
              calls.push(`renderer:${ctx.channel.state.channelId}`);
              await next({ ...event, data: { ...event.data, value: "Done!" } });
            },
          },
        }),
      ],
      {
        events: { "content.completed": fallback },
        received: async () => undefined,
        taskCard: () => null,
      },
    );

    await invoke(chain.events["content.completed"], completed);

    expect(calls).toEqual(["renderer:C1", "default:Done!"]);
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("hands a sign-in's renderer only the private delivery surface", async () => {
    let seen: unknown;
    const chain = composeSlackRenderers(
      [
        defineSlackRenderer({
          events: {
            async "interaction.opened"(_event, ctx) {
              seen = ctx.channel;
            },
          },
        }),
      ],
      { events: {}, received: async () => undefined, taskCard: () => null },
    );
    const signIn: ChannelEventOf<"interaction.opened"> = {
      data: {
        interactionId: "int_0",
        request: { kind: "sign-in", prompt: "Sign in to Linear.", signIn: { name: "linear" } },
        subject: { callId: "call_0" },
      },
      scope: { turnId: "turn_0" },
      type: "interaction.opened",
    };

    await invoke(chain.events["interaction.opened"], signIn);

    expect(Object.keys(seen as object).sort()).toEqual([
      "postDirectMessage",
      "postEphemeral",
      "state",
    ]);
  });
});
