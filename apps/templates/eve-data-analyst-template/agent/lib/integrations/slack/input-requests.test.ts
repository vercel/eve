import { beforeEach, expect, it, vi } from "vitest";

import {
  interactionOpenedHarness,
  slackEventContext,
} from "../../testing/slack";
import { installTestState, testState } from "../../testing/state";
import { createInputRequestEvents } from "./input-requests";
import type { SlackInputRequest } from "./input-requests";

const request: SlackInputRequest = {
  call: { callId: "call-1", input: {}, name: "guarded" },
  interactionId: "approval-1",
  request: { kind: "approval", prompt: "Approve this action?" },
  status: "open",
  stepIndex: 0,
  turnId: "turn-1",
};
beforeEach(() => {
  testState.reset();
  installTestState();
});

it("delegates uncustomized interactions to eve without posting another card", async () => {
  const harness = interactionOpenedHarness(request);
  await harness.run(createInputRequestEvents()["interaction.opened"]);
  expect(harness.channel.thread.post).not.toHaveBeenCalled();
  expect(harness.next).toHaveBeenCalledOnce();
});

it("leaves sign-in delivery private and never invokes the preview renderer", async () => {
  const render = vi.fn();
  const harness = interactionOpenedHarness({
    ...request,
    request: {
      kind: "sign-in",
      link: { url: "https://example.com/private-challenge" },
      prompt: "Sign in",
    },
  });
  await harness.run(createInputRequestEvents({ render })["interaction.opened"]);
  expect(render).not.toHaveBeenCalled();
  expect(harness.channel.thread.post).not.toHaveBeenCalled();
  expect(harness.next).toHaveBeenCalledOnce();
});

it("posts the preview once on replay and confirms it only after native rendering", async () => {
  const onPosted = vi.fn();
  const harness = interactionOpenedHarness(request);
  const handler = createInputRequestEvents({
    render: () => ({ blocks: [], onPosted, text: "Frozen scope" }),
  })["interaction.opened"];
  await harness.run(handler);
  await harness.run(handler);
  expect(harness.channel.thread.post).toHaveBeenCalledOnce();
  expect(harness.next).toHaveBeenCalledTimes(2);
  expect(onPosted).toHaveBeenCalledWith("posted-ts");
  expect(harness.next.mock.invocationCallOrder[0]).toBeLessThan(
    onPosted.mock.invocationCallOrder[0] ?? 0
  );
});

it.each([
  { id: "", raw: { ok: true } },
  { id: "posted", raw: { ok: false } },
])("fails closed on unconfirmed preview delivery %j", async (receipt) => {
  const onPosted = vi.fn();
  const harness = interactionOpenedHarness(
    request,
    slackEventContext({
      thread: { post: vi.fn(() => Promise.resolve(receipt)) },
    })
  );
  const handler = createInputRequestEvents({
    render: () => ({ blocks: [], onPosted, text: "Frozen scope" }),
  })["interaction.opened"];
  await expect(harness.run(handler)).rejects.toThrow(
    "Could not confirm delivery"
  );
  expect(onPosted).not.toHaveBeenCalled();
  expect(harness.next).not.toHaveBeenCalled();
});

it("does not confirm a preview when native rendering fails", async () => {
  const onPosted = vi.fn();
  const harness = interactionOpenedHarness(request);
  harness.next.mockRejectedValue(new Error("delivery failed"));
  await expect(
    harness.run(
      createInputRequestEvents({
        render: () => ({ blocks: [], onPosted, text: "Frozen scope" }),
      })["interaction.opened"]
    )
  ).rejects.toThrow("delivery failed");
  expect(onPosted).not.toHaveBeenCalled();
});
