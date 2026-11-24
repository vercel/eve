import { expect, it } from "vitest";

import { subscriptionKeyWorkflowReference } from "#execution/workflow-references.js";
import { startWorkflowOnCurrentDeployment } from "#execution/workflow-runtime.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { getRun, resumeHook } from "#internal/workflow/runtime.js";
import { emitSubscriptionEvent } from "./owner.js";
import {
  joinAckNamespace,
  subscriptionKeyHookToken,
  type JoinAck,
  type SubscriptionKeyMessage,
} from "./state.js";

const source = { kind: "channel", name: "github" } as const;
const key = "vercel/eve#7:checks_finished";
const event = (id: string) => ({ id, data: {} });

async function acknowledgement(runId: string, ackId: string): Promise<JoinAck | undefined> {
  const reader = getRun(runId)
    .getReadable<JoinAck>({ namespace: joinAckNamespace(ackId) })
    .getReader();
  try {
    return (await reader.read()).value;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

it("keeps one run per key that accepts joins and events while any subscription holds the key", async () => {
  const run = await startWorkflowOnCurrentDeployment(subscriptionKeyWorkflowReference, [
    { source, key, first: "a", ackId: "ack-a" },
  ]);
  const token = subscriptionKeyHookToken(source, key);
  const message = (value: SubscriptionKeyMessage) => resumeHook(token, value);
  try {
    await waitForHook(run, { token });
    await expect(acknowledgement(run.runId, "ack-a")).resolves.toEqual({ joined: true });
    await expect(
      emitSubscriptionEvent(source.name, "vercel/eve#8:checks_finished", event("1")),
    ).resolves.toBe(false);

    await message({ kind: "join", bindingId: "b", ackId: "ack-b" });
    await expect(acknowledgement(run.runId, "ack-b")).resolves.toEqual({ joined: true });
    await message({ kind: "leave", bindingId: "a" });
    expect((await run.status) === "running").toBe(true);

    await message({ kind: "leave", bindingId: "b" });
    await run.returnValue;
    await expect(emitSubscriptionEvent(source.name, key, event("2"))).resolves.toBe(false);
  } finally {
    if ((await run.status) === "running") await run.cancel();
  }
});

it("drops a subscription whose owner has ended on the next event, and ends once none is left", async () => {
  const run = await startWorkflowOnCurrentDeployment(subscriptionKeyWorkflowReference, [
    { source, key, first: "gone", ackId: "ack-gone" },
  ]);
  const token = subscriptionKeyHookToken(source, key);
  try {
    await waitForHook(run, { token });
    await expect(emitSubscriptionEvent(source.name, key, event("1"))).resolves.toBe(true);
    await run.returnValue;
    await expect(emitSubscriptionEvent(source.name, key, event("2"))).resolves.toBe(false);
  } finally {
    if ((await run.status) === "running") await run.cancel();
  }
});

it("hands its first subscription to the run that already holds the key", async () => {
  const holder = await startWorkflowOnCurrentDeployment(subscriptionKeyWorkflowReference, [
    { source, key, first: "a", ackId: "ack-a" },
  ]);
  const token = subscriptionKeyHookToken(source, key);
  let loser: Awaited<ReturnType<typeof startWorkflowOnCurrentDeployment>> | undefined;
  try {
    await waitForHook(holder, { token });
    loser = await startWorkflowOnCurrentDeployment(subscriptionKeyWorkflowReference, [
      { source, key, first: "b", ackId: "ack-b" },
    ]);
    await loser.returnValue;
    await expect(acknowledgement(loser.runId, "ack-b")).resolves.toEqual({
      forwardedTo: holder.runId,
    });
    await expect(acknowledgement(holder.runId, "ack-b")).resolves.toEqual({ joined: true });
  } finally {
    if ((await holder.status) === "running") await holder.cancel();
    if (loser !== undefined && (await loser.status) === "running") await loser.cancel();
  }
});
