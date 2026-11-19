import {
  ANSWER_ACTION_PREFIX,
  renderInteractionBlocks,
} from "eve/channels/slack";
import type { SlackInteractionCard, SlackThread } from "eve/channels/slack";
import { emptySessionView, foldEvents } from "eve/events";
import type { Interaction, InteractionOpened } from "eve/events";
import type { HookEvent } from "eve/hooks";
import { beforeEach, expect, it, vi } from "vitest";

// Exercise eve's actual swallowing dispatcher, renderer chain, and native cards.
import { callAdapterEventHandler } from "../../../../node_modules/eve/dist/src/channel/adapter-event-handler.js";
import { defaultInteractionEvents } from "../../../../node_modules/eve/dist/src/public/channels/slack/defaults.js";
import {
  composeInteractionCards,
  composeSlackRenderers,
} from "../../../../node_modules/eve/dist/src/public/channels/slack/renderers.js";
import {
  channelEventContext,
  interactionOpenedHarness,
  slackEventContext,
} from "../../testing/slack";
import { installTestState, testState } from "../../testing/state";
import { createInteractionRenderer } from "./interactions";
import type { SlackInteractionsConfig } from "./interactions";

const request: Interaction = {
  call: { callId: "call-1", input: {}, name: "guarded" },
  interactionId: "approval-1",
  request: {
    kind: "approval",
    options: [
      { id: "approve", label: "Approve" },
      { id: "deny", label: "Deny" },
    ],
    prompt: "Approve this action?",
  },
  status: "open",
  stepIndex: 0,
  turnId: "turn-1",
};
const handler = (config: SlackInteractionsConfig = {}) => {
  const opened =
    createInteractionRenderer(config).events?.["interaction.opened"];
  if (!opened) {
    throw new Error("Expected interaction delivery handler.");
  }
  return opened;
};
beforeEach(() => {
  testState.reset();
  installTestState();
});

it("delegates uncustomized interactions without posting another card", async () => {
  const harness = interactionOpenedHarness(request);
  await harness.run(handler());
  expect(harness.channel.thread.post).not.toHaveBeenCalled();
  expect(harness.next).toHaveBeenCalledOnce();
});

it("leaves sign-in delivery private and never builds a preview", async () => {
  const details = vi.fn();
  const harness = interactionOpenedHarness({
    ...request,
    request: {
      kind: "sign-in",
      link: { url: "https://example.com/private-challenge" },
      prompt: "Sign in",
    },
  });
  await harness.run(handler({ details }));
  expect(details).not.toHaveBeenCalled();
  expect(harness.channel.thread.post).not.toHaveBeenCalled();
  expect(harness.next).toHaveBeenCalledOnce();
});

const later: Interaction = {
  ...request,
  call: { callId: "call-2", input: {}, name: "publish_contentful_entry" },
  interactionId: "approval-2",
};
const unavailable = (): never => {
  throw new Error("Unexpected adapter context access");
};

const batchDispatcher = (failure?: "preview" | "controls") => {
  const timeline: string[] = [];
  let pendingFailure = failure;
  let sequence = 0;
  const post = vi.fn<SlackThread["post"]>((message) => {
    const json = JSON.stringify(message);
    let kind = "details";
    if (json.includes(ANSWER_ACTION_PREFIX)) {
      kind = "controls";
    } else if (json.includes("Publication scope")) {
      kind = "preview";
    }
    if (kind === pendingFailure) {
      pendingFailure = undefined;
      throw new Error(`Failed ${kind}`);
    }
    timeline.push(kind);
    sequence += 1;
    return Promise.resolve({ id: `posted-${sequence}`, raw: { ok: true } });
  });
  const channel = slackEventContext({ thread: { post } });
  const onPosted = vi.fn(() => timeline.push("checkpoint"));
  const renderer = createInteractionRenderer({
    details: (item) =>
      item.interactionId === later.interactionId
        ? { blocks: [], onPosted, text: "Publication scope" }
        : undefined,
  });
  const native = defaultInteractionEvents(
    undefined,
    composeInteractionCards([renderer])
  );
  const chain = composeSlackRenderers([renderer], {
    events: native,
    received: () => Promise.resolve(),
    taskCard: () => null,
  });
  const opened: InteractionOpened[] = [request, later].map((item) => ({
    data: {
      interactionId: item.interactionId,
      request: item.request,
      subject: { callId: item.call?.callId ?? "call-1" },
    },
    type: "interaction.opened",
  }));
  const facts: HookEvent[] = [
    {
      data: {
        cause: { deliveryId: "delivery-1" },
        follows: null,
        turnId: request.turnId,
      },
      type: "turn.started",
    },
    ...[request, later].map((item) => ({
      data: {
        callId: item.call?.callId ?? "call-1",
        capability: {
          kind: "tool" as const,
          name: item.call?.name ?? "guarded",
        },
        input: {},
        owner: { turnId: item.turnId },
      },
      type: "call.requested" as const,
    })),
    ...opened,
  ];
  const view = foldEvents(
    emptySessionView(),
    facts.map((event, index) => ({
      ...event,
      meta: {
        at: "2026-10-10T00:00:00.000Z",
        endOfLine: index === facts.length - 1,
        position: { index, line: 0 },
      },
    }))
  );
  const ctx = { ...channelEventContext(channel), view };
  const adapter = {
    "interaction.opened": (event: InteractionOpened) =>
      chain.events["interaction.opened"]?.(event, ctx),
    kind: "slack-test",
  };
  const dispatch = async (index: number) => {
    const event = opened[index];
    if (!event) {
      throw new Error("Missing interaction event");
    }
    await callAdapterEventHandler(adapter, event, {
      ctx: {
        ensure: unavailable,
        get: unavailable,
        has: unavailable,
        require: unavailable,
        set: unavailable,
      },
      session: ctx.session,
      state: {},
    });
  };
  return { dispatch, onPosted, post, timeline };
};

it("checkpoints native control delivery only on the leader and reuses previews on leader replay", async () => {
  const harness = batchDispatcher();
  await harness.dispatch(0);
  await harness.dispatch(1);
  expect(harness.timeline).toEqual(["preview", "controls", "checkpoint"]);
  expect(harness.onPosted).toHaveBeenCalledExactlyOnceWith("posted-1");
  const controls = JSON.stringify(
    harness.post.mock.calls.find(([message]) =>
      JSON.stringify(message).includes(ANSWER_ACTION_PREFIX)
    )
  );
  expect(controls).toContain(request.interactionId);
  expect(controls).toContain(later.interactionId);
  await harness.dispatch(0);
  expect(harness.timeline.filter((kind) => kind === "preview")).toHaveLength(1);
  expect(harness.onPosted).toHaveBeenCalledTimes(2);
});

it.each(["preview", "controls"] as const)(
  "fails closed when the dispatcher swallows a leader %s failure and continues to the nonleader",
  async (failure) => {
    const harness = batchDispatcher(failure);
    await harness.dispatch(0);
    await harness.dispatch(1);
    expect(harness.timeline.filter((kind) => kind === "preview")).toHaveLength(
      1
    );
    expect(harness.timeline).not.toContain("controls");
    expect(harness.onPosted).not.toHaveBeenCalled();
    await harness.dispatch(1);
    expect(harness.onPosted).not.toHaveBeenCalled();
    await harness.dispatch(0);
    expect(harness.timeline.filter((kind) => kind === "preview")).toHaveLength(
      1
    );
    expect(harness.timeline.slice(-2)).toEqual(["controls", "checkpoint"]);
    expect(harness.onPosted).toHaveBeenCalledOnce();
  }
);

const publicationDetails: SlackInteractionsConfig["details"] = (item) =>
  item.call?.name === "publish_contentful_entry"
    ? { blocks: [], text: "Publication scope" }
    : undefined;

it("delivers a later publication preview before the first event renders the group's controls", async () => {
  const channel = slackEventContext();
  const first = interactionOpenedHarness(request, channel, [request, later]);
  await first.run(handler({ details: publicationDetails }));
  expect(channel.thread.post).toHaveBeenCalledExactlyOnceWith({
    blocks: [],
    text: "Publication scope",
  });
  expect(
    vi.mocked(channel.thread.post).mock.invocationCallOrder[0]
  ).toBeLessThan(first.next.mock.invocationCallOrder[0] ?? 0);
  const second = interactionOpenedHarness(later, channel, [request, later]);
  await second.run(handler({ details: publicationDetails }));
  expect(channel.thread.post).toHaveBeenCalledOnce();
});

it.each([
  { id: "", raw: { ok: true } },
  { id: "posted", raw: { ok: false } },
])(
  "withholds the whole group's controls after unconfirmed delivery %j",
  async (receipt) => {
    const channel = slackEventContext({
      thread: { post: vi.fn(() => Promise.resolve(receipt)) },
    });
    const harness = interactionOpenedHarness(request, channel, [
      request,
      later,
    ]);
    await expect(
      harness.run(handler({ details: publicationDetails }))
    ).rejects.toThrow("Could not confirm delivery");
    expect(harness.next).not.toHaveBeenCalled();
  }
);

it("does not let an earlier turn's missing preview block the current controls", async () => {
  const harness = interactionOpenedHarness(request, undefined, [
    { ...later, turnId: "turn-old" },
    request,
  ]);
  await harness.run(
    handler({
      details: (item) => {
        if (item.interactionId === later.interactionId) {
          throw new Error("No preview for other group");
        }
      },
    })
  );
  expect(harness.next).toHaveBeenCalledOnce();
});

it("refuses oversized previews before posting controls", async () => {
  const harness = interactionOpenedHarness(request);
  await expect(
    harness.run(
      handler({
        details: () => ({
          blocks: Array.from({ length: 51 }, () => ({ type: "divider" })),
          text: "Too long",
        }),
      })
    )
  ).rejects.toThrow("50-block");
  expect(harness.channel.thread.post).not.toHaveBeenCalled();
  expect(harness.next).not.toHaveBeenCalled();
});

const renderDefault = (input: SlackInteractionCard) => ({
  controls: {
    blocks: renderInteractionBlocks(input.interaction),
    text: input.interaction.request.prompt,
  },
});

it("keeps native control identities while labeling open and answered publication cards", () => {
  const interaction = {
    ...later,
    request: {
      ...later.request,
      options: [
        { id: "approve", label: "Approve" },
        { id: "deny", label: "Deny" },
      ],
    },
  };
  const card: SlackInteractionCard = {
    audience: "public",
    destination: "thread",
    interaction,
    view: emptySessionView(),
  };
  const renderer = createInteractionRenderer({
    labels: () => ({ approve: "Publish", deny: "Cancel" }),
  });
  const parts = renderer.interactionCard?.(card, renderDefault);
  const json = JSON.stringify(parts);
  expect(json).toContain('"text":"Publish"');
  expect(json).toContain('"text":"Cancel"');
  expect(json.match(/"action_id":"[^"]+"/gu)).toEqual(
    JSON.stringify(renderDefault(card)).match(/"action_id":"[^"]+"/gu)
  );
  const settledDefault = vi.fn(renderDefault);
  renderer.interactionCard?.(
    { ...card, interaction: { ...interaction, status: "settled" } },
    settledDefault
  );
  expect(settledDefault.mock.calls[0]?.[0].interaction.request.options).toEqual(
    [
      { id: "approve", label: "Publish" },
      { id: "deny", label: "Cancel" },
    ]
  );
});
