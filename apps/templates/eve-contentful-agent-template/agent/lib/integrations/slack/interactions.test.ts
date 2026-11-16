import { renderInteractionBlocks } from "eve/channels/slack";
import type { SlackInteractionCard } from "eve/channels/slack";
import { emptySessionView } from "eve/events";
import type { Interaction } from "eve/events";
import { beforeEach, expect, it, vi } from "vitest";

import {
  interactionOpenedHarness,
  slackEventContext,
} from "../../testing/slack";
import { installTestState, testState } from "../../testing/state";
import { createInteractionRenderer } from "./interactions";
import type { SlackInteractionsConfig } from "./interactions";

const request: Interaction = {
  call: { callId: "call-1", input: {}, name: "guarded" },
  interactionId: "approval-1",
  request: { kind: "approval", prompt: "Approve this action?" },
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

it("checkpoints confirmed preview delivery after controls and reuses it on replay", async () => {
  const onPosted = vi.fn();
  const harness = interactionOpenedHarness(request);
  const opened = handler({
    details: () => ({ blocks: [], onPosted, text: "Frozen scope" }),
  });
  await harness.run(opened);
  await harness.run(opened);
  expect(harness.channel.thread.post).toHaveBeenCalledOnce();
  expect(harness.next).toHaveBeenCalledTimes(2);
  expect(onPosted).toHaveBeenCalledWith("posted-ts");
  expect(harness.next.mock.invocationCallOrder[0]).toBeLessThan(
    onPosted.mock.invocationCallOrder[0] ?? 0
  );
});

it("does not unlock publication if native rendering fails, and reuses the delivered preview on retry", async () => {
  const onPosted = vi.fn();
  const harness = interactionOpenedHarness(request);
  const opened = handler({
    details: () => ({ blocks: [], onPosted, text: "Frozen scope" }),
  });
  harness.next.mockRejectedValueOnce(new Error("Controls delivery failed"));
  await expect(harness.run(opened)).rejects.toThrow("Controls delivery failed");
  expect(onPosted).not.toHaveBeenCalled();
  await harness.run(opened);
  expect(harness.channel.thread.post).toHaveBeenCalledOnce();
  expect(onPosted).toHaveBeenCalledExactlyOnceWith("posted-ts");
});

const later: Interaction = {
  ...request,
  call: { callId: "call-2", input: {}, name: "publish_contentful_entry" },
  interactionId: "approval-2",
};
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
