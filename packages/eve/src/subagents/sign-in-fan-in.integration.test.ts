import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  ConnectionAuthorizationFailedError,
  ConnectionAuthorizationRequiredError,
} from "#connections/errors.js";
import { defineDynamic } from "#dynamic/definition.js";
import { resumeAuthorizationCallback } from "#execution/legacy-session/authorization.js";
import { workflowEntry } from "#execution/session/entry.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import { buildSerializedContext, captureEvents } from "#internal/testing/entry-test-helpers.js";
import { filterEventsByType } from "#internal/testing/events.js";
import { startSessionOwner, waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { parseEveConnectionCallbackRoutePath } from "#protocol/routes.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { defineAgent } from "#public/definitions/agent.js";
import type { AuthorizationDefinition, TokenResult } from "#shared/connection-types.js";
import { defineTool } from "#tools/definition.js";
import { getWorld, resumeHook } from "#internal/workflow/runtime.js";

// A parent runs three children at once, and each child's tool needs a Weather sign-in for the
// same person, and with `parentAsks` the parent's own tool needs it too. Each sign-in relays to the parent as its own card, and the person's answer on one
// reaches every child waiting on the same grant. The authorization provider is faked at its edge.

vi.setConfig({ testTimeout: 90_000 });

const CHILDREN = 3;

const ALICE = {
  attributes: {},
  authenticator: "test-idp",
  issuer: "test-idp",
  principalId: "alice",
  principalType: "user" as const,
};

describe("one sign-in answer for parallel children", () => {
  it("completes every child's sign-in for the same Connect grant when the person signs in once", async () => {
    const app = await createApp("sign-in-fan-in-shared", { grant: "oauth/weather" });

    await app.runtime.run(async () => {
      const run = await startParent(app.name);
      const stream = captureEvents(run);
      try {
        const before = await signInCards(stream, CHILDREN);
        const [card] = before.filter(isSignInOpened);
        await completeSignIn(card!, { code: "oauth-code" });
        const after = await stream.nextUntil("parent turn", isTurnSettled);

        const events = [...before, ...after];
        const opened = events.filter(isSignInOpened);
        expect(opened, "sign-ins the parent records").toHaveLength(CHILDREN);
        expect(opened.filter(isShownCard), "cards the person sees").toEqual([card]);
        expect(opened.slice(1).map(waitsOnOf), "the card the others wait on").toEqual(
          Array.from({ length: CHILDREN - 1 }, () => signInId(card!)),
        );
        expect(app.starts(), "sign-ins the children started").toBe(CHILDREN);
        expect(app.completes(), "sign-ins the children completed").toBe(CHILDREN);
        expect(app.executions().toSorted()).toEqual(["Lisbon 0", "Lisbon 1", "Lisbon 2"]);
        expect(signInOutcomes(events), "how each card closed").toEqual([
          "accepted",
          "accepted",
          "accepted",
        ]);
        expect(filterEventsByType(events, "turn.settled").map((e) => e.data.outcome)).toEqual([
          "completed",
        ]);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("completes the other children's sign-ins while the answered child's call still runs", async () => {
    const app = await createApp("sign-in-fan-in-held", { grant: "oauth/weather", holdFirst: true });

    await app.runtime.run(async () => {
      const run = await startParent(app.name);
      const stream = captureEvents(run);
      try {
        const before = await signInCards(stream, CHILDREN);
        const [card] = before.filter(isSignInOpened);
        await completeSignIn(card!, { code: "oauth-code" });
        // The answered child's call holds after its sign-in completes; the others still run.
        await app.othersRan();
        expect(app.executions(), "calls that ran while one held").toHaveLength(CHILDREN - 1);
        app.release();
        const after = await stream.nextUntil("parent turn", isTurnSettled);

        expect([...before, ...after].filter(isSignInOpened).filter(isShownCard)).toEqual([card]);
        expect(app.executions()).toHaveLength(CHILDREN);
        expect(filterEventsByType(after, "turn.settled").map((e) => e.data.outcome)).toEqual([
          "completed",
        ]);
      } finally {
        app.release();
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("delivers the answer again after a delivery to one child fails, with no other card", async () => {
    const app = await createApp("sign-in-fan-in-retry", { grant: "oauth/weather" });

    await app.runtime.run(async () => {
      const run = await startParent(app.name);
      const stream = captureEvents(run);
      try {
        const before = await signInCards(stream, CHILDREN);
        const [card, ...others] = before.filter(isSignInOpened);
        // The first delivery to one other child fails, as a storage fault would.
        const faulty = await failOnce(callbackToken(others[0]!));

        await completeSignIn(card!, { code: "oauth-code" });
        const after = await stream.nextUntil("parent turn", isTurnSettled);

        expect(faulty.thrown(), "deliveries that failed").toBe(1);
        expect([...before, ...after].filter(isSignInOpened), "sign-in cards").toHaveLength(
          CHILDREN,
        );
        expect(app.completes(), "sign-ins the children completed").toBe(CHILDREN);
        expect(app.executions().toSorted()).toEqual(["Lisbon 0", "Lisbon 1", "Lisbon 2"]);
        expect(filterEventsByType(after, "turn.settled").map((e) => e.data.outcome)).toEqual([
          "completed",
        ]);
      } finally {
        await restoreWorld();
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("ends every child's sign-in when the person declines one, with no other card", async () => {
    const app = await createApp("sign-in-fan-in-declined", { grant: "oauth/weather" });

    await app.runtime.run(async () => {
      const run = await startParent(app.name);
      const stream = captureEvents(run);
      try {
        const before = await signInCards(stream, CHILDREN);
        const [card] = before.filter(isSignInOpened);
        await completeSignIn(card!, { error: "access_denied" });
        const after = await stream.nextUntil("parent turn", isTurnSettled);

        const events = [...before, ...after];
        expect(events.filter(isSignInOpened), "sign-in cards in the parent").toHaveLength(CHILDREN);
        expect(signInOutcomes(events), "how each card closed").toEqual([
          "declined",
          "declined",
          "declined",
        ]);
        expect(app.completes(), "sign-ins completed at the provider").toBe(0);
        expect(app.executions(), "calls that ran").toEqual([]);
        expect(filterEventsByType(events, "turn.settled").map((e) => e.data.outcome)).toEqual([
          "completed",
        ]);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("fails the sign-ins that wait on a card that fails, so none waits without a card", async () => {
    const app = await createApp("sign-in-fan-in-failed", { grant: "oauth/weather" });

    await app.runtime.run(async () => {
      const run = await startParent(app.name);
      const stream = captureEvents(run);
      try {
        const events = [...(await signInCards(stream, CHILDREN))];
        const [card, ...waiting] = events.filter(isSignInOpened);
        expect(waiting.map(waitsOnOf), "the card the others wait on").toEqual(
          waiting.map(() => signInId(card!)),
        );
        await completeSignIn(card!, { error: "server_error" });
        events.push(...(await stream.nextUntil("parent turn", isTurnSettled)));

        expect(signInOutcomes(events), "how each sign-in closed").toEqual(
          Array.from({ length: CHILDREN }, () => "failed"),
        );
        expect(app.executions(), "calls that ran").toEqual([]);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("shows a new card when the grant is gone after an earlier sign-in, and finishes from it", async () => {
    const app = await createApp("sign-in-fan-in-revoked", {
      again: true,
      children: 1,
      grant: "oauth/weather",
    });

    await app.runtime.run(async () => {
      const run = await startParent(app.name);
      const stream = captureEvents(run);
      try {
        const events = [...(await signInCards(stream, 1))];
        await completeSignIn(events.find(isSignInOpened)!, { code: "oauth-code" });
        // The child's next call finds the grant revoked, so it asks again.
        events.push(...(await signInCards(stream, 1)));
        const cards = events.filter(isSignInOpened);
        expect(cards, "sign-in cards in the parent").toHaveLength(2);

        await completeSignIn(cards[1]!, { code: "oauth-code" });
        events.push(...(await stream.nextUntil("parent turn", isTurnSettled)));

        expect(app.executions()).toEqual(["Lisbon 0", "Porto 0"]);
        expect(signInOutcomes(events), "how each card closed").toEqual(["accepted", "accepted"]);
        expect(filterEventsByType(events, "turn.settled").map((e) => e.data.outcome)).toEqual([
          "completed",
        ]);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("completes only the answered child's sign-in when the sign-ins carry no grant", async () => {
    const app = await createApp("sign-in-fan-in-no-grant", {});

    await app.runtime.run(async () => {
      const run = await startParent(app.name);
      const stream = captureEvents(run);
      try {
        const events = [...(await signInCards(stream, CHILDREN))];
        const cards = events.filter(isSignInOpened);

        await completeSignIn(cards[0]!, { code: "oauth-code" });
        await vi.waitFor(() => expect(app.executions()).toHaveLength(1), { timeout: 30_000 });
        expect(app.completes(), "sign-ins completed by one answer").toBe(1);

        for (const card of cards.slice(1)) await completeSignIn(card, { code: "oauth-code" });
        events.push(...(await stream.nextUntil("parent turn", isTurnSettled)));

        expect(events.filter(isSignInOpened).filter(isShownCard), "cards").toHaveLength(CHILDREN);
        expect(app.completes()).toBe(CHILDREN);
        expect(app.executions().toSorted()).toEqual(["Lisbon 0", "Lisbon 1", "Lisbon 2"]);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });
  it("completes every child's sign-in when the person answers the parent's own", async () => {
    const app = await createApp("sign-in-fan-in-parent-answers", {
      grant: "oauth/weather",
      parentAsks: true,
    });

    await app.runtime.run(async () => {
      const run = await startParent(app.name);
      const stream = captureEvents(run);
      try {
        const before = await signInCards(stream, CHILDREN + 1);
        const parents = before.filter(isSignInOpened).filter(isOwnSignIn);
        expect(parents, "the parent's own sign-in cards").toHaveLength(1);
        await completeSignIn(parents[0]!, { code: "oauth-code" });
        const after = await stream.nextUntil("parent turn", isTurnSettled);

        const events = [...before, ...after];
        expect(events.filter(isSignInOpened).filter(isShownCard), "cards").toHaveLength(1);
        expect(signInOutcomes(events), "how each card closed").toEqual(
          Array.from({ length: CHILDREN + 1 }, () => "accepted"),
        );
        expect(app.executions().toSorted()).toEqual([
          "Lisbon 0",
          "Lisbon 1",
          "Lisbon 2",
          "Lisbon parent",
        ]);
        expect(filterEventsByType(events, "turn.settled").map((e) => e.data.outcome)).toEqual([
          "completed",
        ]);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("completes the parent's own sign-in when the person answers a child's", async () => {
    const app = await createApp("sign-in-fan-in-child-answers-parent", {
      grant: "oauth/weather",
      parentAsks: true,
    });

    await app.runtime.run(async () => {
      const run = await startParent(app.name);
      const stream = captureEvents(run);
      try {
        const before = await signInCards(stream, CHILDREN + 1);
        const child = before.filter(isSignInOpened).find((card) => !isOwnSignIn(card));
        expect(before.filter(isSignInOpened).filter(isShownCard), "cards").toHaveLength(1);
        await completeSignIn(child!, { code: "oauth-code" });
        const after = await stream.nextUntil("parent turn", isTurnSettled);

        const events = [...before, ...after];
        expect(signInOutcomes(events), "how each card closed").toEqual(
          Array.from({ length: CHILDREN + 1 }, () => "accepted"),
        );
        expect(app.executions()).toContain("Lisbon parent");
        expect(app.executions()).toHaveLength(CHILDREN + 1);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("ends the children's sign-ins when the person declines the parent's own", async () => {
    const app = await createApp("sign-in-fan-in-parent-declines", {
      grant: "oauth/weather",
      parentAsks: true,
    });

    await app.runtime.run(async () => {
      const run = await startParent(app.name);
      const stream = captureEvents(run);
      try {
        const before = await signInCards(stream, CHILDREN + 1);
        const parent = before.filter(isSignInOpened).find(isOwnSignIn);
        await completeSignIn(parent!, { error: "access_denied" });
        const after = await stream.nextUntil("parent turn", isTurnSettled);

        expect(signInOutcomes([...before, ...after]), "how each card closed").toEqual(
          Array.from({ length: CHILDREN + 1 }, () => "declined"),
        );
        expect(app.completes(), "sign-ins completed at the provider").toBe(0);
        expect(app.executions(), "calls that ran").toEqual([]);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("completes the children's sign-ins from the parent's card when it opens first", async () => {
    const app = await createApp("sign-in-fan-in-parent-first", {
      grant: "oauth/weather",
      parentAsks: "first",
    });

    await app.runtime.run(async () => {
      const run = await startParent(app.name);
      const stream = captureEvents(run);
      try {
        const before = await parentCardFirst(app, stream);
        const [first] = before.filter(isSignInOpened);
        expect(before.filter(isSignInOpened).filter(isShownCard), "cards").toEqual([first]);
        await completeSignIn(first!, { code: "oauth-code" });
        const after = await stream.nextUntil("parent turn", isTurnSettled);

        expect(signInOutcomes([...before, ...after]), "how each card closed").toEqual(
          Array.from({ length: CHILDREN + 1 }, () => "accepted"),
        );
        expect(app.executions()).toHaveLength(CHILDREN + 1);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("ends the children's sign-ins when a message withdraws the parent's card they wait on", async () => {
    const app = await createApp("sign-in-fan-in-parent-withdrawn", {
      grant: "oauth/weather",
      parentAsks: "first",
    });

    await app.runtime.run(async () => {
      const run = await startParent(app.name);
      const stream = captureEvents(run);
      try {
        const before = await parentCardFirst(app, stream);
        const inbox = sessionInboxHookToken(`http:${app.name}`);
        await waitForHook({ runId: run.runId }, { token: inbox });
        await resumeHook(inbox, {
          auth: ALICE,
          kind: "send",
          delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
          payload: { message: "Never mind the parent's weather." },
        });
        const after = await stream.nextUntil("parent turn", isTurnSettled);

        const events = [...before, ...after];
        const cards = events.filter(isSignInOpened).map(signInId);
        const settled = new Set(
          filterEventsByType(events, "interaction.settled").map((e) => e.data.interactionId),
        );
        expect(
          cards.filter((id) => !settled.has(id)),
          "sign-ins left without a card",
        ).toEqual([]);
        expect(signInOutcomes(events).toSorted(), "how each card closed").toEqual([
          ...Array.from({ length: CHILDREN }, () => "failed"),
          "withdrawn",
        ]);
        expect(app.executions(), "calls that ran").toEqual([]);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("shows one card for a single child, which runs its call once after the person signs in", async () => {
    const app = await createApp("sign-in-fan-in-single", { children: 1, grant: "oauth/weather" });

    await app.runtime.run(async () => {
      const run = await startParent(app.name);
      const stream = captureEvents(run);
      try {
        const before = await signInCards(stream, 1);
        const [card] = before.filter(isSignInOpened);
        await completeSignIn(card!, { code: "oauth-code" });
        const after = await stream.nextUntil("parent turn", isTurnSettled);

        const events = [...before, ...after];
        expect(events.filter(isSignInOpened), "sign-ins the parent records").toEqual([card]);
        expect(waitsOnOf(card!), "the card waits on another").toBeUndefined();
        expect(app.starts(), "sign-ins the child started").toBe(1);
        expect(app.completes(), "sign-ins the child completed").toBe(1);
        expect(app.executions(), "calls that ran").toEqual(["Lisbon 0"]);
        expect(signInOutcomes(events), "how the card closed").toEqual(["accepted"]);
        expect(filterEventsByType(events, "turn.settled").map((e) => e.data.outcome)).toEqual([
          "completed",
        ]);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("opens no other sign-in for the rest of the turn after the person declines", async () => {
    const app = await createApp("sign-in-fan-in-declined-no-reask", { grant: "oauth/weather" });

    await app.runtime.run(async () => {
      const run = await startParent(app.name);
      const stream = captureEvents(run);
      try {
        const before = await signInCards(stream, CHILDREN);
        const [card] = before.filter(isSignInOpened);
        await completeSignIn(card!, { error: "access_denied" });
        const after = await stream.nextUntil("parent turn", isTurnSettled);

        expect(after.filter(isSignInOpened), "sign-ins opened after the decline").toEqual([]);
        expect(app.starts(), "sign-ins the children started").toBe(CHILDREN);
        expect(signInOutcomes([...before, ...after]), "how each sign-in closed").toEqual(
          Array.from({ length: CHILDREN }, () => "declined"),
        );
        expect(app.executions(), "calls that ran").toEqual([]);
        expect(filterEventsByType(after, "turn.settled").map((e) => e.data.outcome)).toEqual([
          "completed",
        ]);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("fails every child's sign-in with the error when the answered one's token exchange fails", async () => {
    const failure = "The token endpoint answered 500.";
    const app = await createApp("sign-in-fan-in-exchange-error", {
      exchangeFails: failure,
      grant: "oauth/weather",
    });

    await app.runtime.run(async () => {
      const run = await startParent(app.name);
      const stream = captureEvents(run);
      try {
        const before = await signInCards(stream, CHILDREN);
        const [card] = before.filter(isSignInOpened);
        await completeSignIn(card!, { code: "oauth-code" });
        const after = await stream.nextUntil("parent turn", isTurnSettled);

        const events = [...before, ...after];
        expect(after.filter(isSignInOpened), "sign-ins opened after the failure").toEqual([]);
        const [shown, ...waiting] = signInSettlements(events);
        expect(shown, "how the shown card closed").toEqual({ outcome: "failed", reason: failure });
        expect(
          waiting.map(({ outcome }) => outcome),
          "how the waiting sign-ins closed",
        ).toEqual(Array.from({ length: CHILDREN - 1 }, () => "failed"));
        // Each waiting child's sign-in hears the shown card's error, not a code.
        expect(app.callbacks(), "the callbacks each child's exchange read").toEqual([
          { code: "oauth-code" },
          ...Array.from({ length: CHILDREN - 1 }, () => ({ error: failure })),
        ]);
        expect(app.executions(), "calls that ran").toEqual([]);
        expect(filterEventsByType(after, "turn.settled").map((e) => e.data.outcome)).toEqual([
          "completed",
        ]);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("runs a child that asks after the card settled on the stored grant, with no other card", async () => {
    const app = await createApp("sign-in-fan-in-late-joiner", {
      children: 2,
      grant: "oauth/weather",
      lateChild: true,
    });

    await app.runtime.run(async () => {
      const run = await startParent(app.name);
      const stream = captureEvents(run);
      try {
        const events = [...(await signInCards(stream, 1))];
        const [card] = events.filter(isSignInOpened);
        await completeSignIn(card!, { code: "oauth-code" });
        events.push(
          ...(await stream.nextUntil(
            "the card settled",
            (event) =>
              event.type === "interaction.settled" && event.data.interactionId === signInId(card!),
          )),
        );
        await vi.waitFor(() => expect(app.executions()).toEqual(["Lisbon 0"]), {
          timeout: 30_000,
        });
        // The held child asks for the same grant only now, after the card settled.
        app.releaseLate();
        events.push(...(await stream.nextUntil("parent turn", isTurnSettled)));

        expect(events.filter(isSignInOpened), "sign-ins the parent records").toEqual([card]);
        expect(app.starts(), "sign-ins the children started").toBe(1);
        expect(app.completes(), "sign-ins the children completed").toBe(1);
        expect(app.executions(), "calls that ran").toEqual(["Lisbon 0", "Lisbon 1"]);
        expect(signInOutcomes(events), "how the card closed").toEqual(["accepted"]);
        expect(filterEventsByType(events, "turn.settled").map((e) => e.data.outcome)).toEqual([
          "completed",
        ]);
      } finally {
        app.releaseLate();
        stream.dispose();
        await run.cancel();
      }
    });
  });
});

let restoreWorld = async () => {};

/** Fails the first lookup of the hook `token` names, as a storage fault would. */
async function failOnce(token: string) {
  let thrown = 0;
  const world = await getWorld();
  const original = world.hooks.getByToken;
  world.hooks.getByToken = async (...args) => {
    if (args[0] === token && thrown === 0) {
      thrown += 1;
      throw new Error("The session store is unavailable.");
    }
    return await original.apply(world.hooks, args);
  };
  restoreWorld = async () => {
    world.hooks.getByToken = original;
    restoreWorld = async () => {};
  };
  return { thrown: () => thrown };
}

/** The hook token a sign-in card's callback URL names. */
function callbackToken(card: SessionStreamEvent): string {
  if (card.type !== "interaction.opened") throw new Error("Expected a sign-in card.");
  const url = card.data.request.signIn?.callbackUrl;
  const callback =
    url === undefined ? undefined : parseEveConnectionCallbackRoutePath(new URL(url).pathname);
  if (callback === undefined) throw new Error("Expected the sign-in to name its callback.");
  return callback.token;
}

/** Reads the stream until the parent shows `count` sign-in cards. */
async function signInCards(
  stream: ReturnType<typeof captureEvents>,
  count: number,
): Promise<SessionStreamEvent[]> {
  const events: SessionStreamEvent[] = [];
  while (events.filter(isSignInOpened).length < count)
    events.push(...(await stream.nextUntil("sign-in card", isSignInOpened)));
  return events;
}

/** The parent's own card, then the children's, which ask only once it is open. */
async function parentCardFirst(
  app: { readonly releaseChildren: () => void },
  stream: ReturnType<typeof captureEvents>,
): Promise<SessionStreamEvent[]> {
  const parent = await signInCards(stream, 1);
  expect(parent.filter(isSignInOpened).map(isOwnSignIn), "the first card is the parent's").toEqual([
    true,
  ]);
  app.releaseChildren();
  return [...parent, ...(await signInCards(stream, CHILDREN))];
}

/** How the parent's sign-in cards closed and why, in the order they closed. */
function signInSettlements(events: readonly SessionStreamEvent[]) {
  const cards = new Set(events.filter(isSignInOpened).map(signInId));
  return filterEventsByType(events, "interaction.settled")
    .filter((event) => cards.has(event.data.interactionId))
    .map(({ data }) => ({ outcome: data.outcome, reason: data.reason }));
}

/** How the parent's sign-in cards closed, in the order they closed. */
function signInOutcomes(events: readonly SessionStreamEvent[]): string[] {
  const cards = new Set(events.filter(isSignInOpened).map(signInId));
  return filterEventsByType(events, "interaction.settled")
    .filter((event) => cards.has(event.data.interactionId))
    .map((event) => event.data.outcome);
}

type Prompt = LanguageModelV4CallOptions["prompt"];

/**
 * The parent starts `children` children in one step and waits for their reports. A child, whose
 * conversation starts with the parent's message, checks the weather and reports; with `again`,
 * child 0 then checks Porto's under another scope of the same grant. With `parentAsks`, the
 * parent checks Lisbon's weather itself while the children run.
 */
function scriptedModel(children: number, again: boolean, parentAsks: boolean | "first") {
  let waits = 0;
  return markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }: { prompt: Prompt }) => {
        const raw = JSON.stringify(prompt);
        const called = (tool: string) => raw.includes(`"toolName":"${tool}"`);
        const first = JSON.stringify(prompt.find((message) => message.role === "user")?.content);
        const child = /CHILD (\d)/u.exec(first)?.[1];
        if (child !== undefined) {
          if (again && child === "0" && called("get_weather") && !raw.includes("Porto"))
            return toolCallsStreamResult([
              {
                input: JSON.stringify({ city: "Porto 0" }),
                toolCallId: "call_weather_porto",
                toolName: "get_weather",
              },
            ]);
          return called("get_weather")
            ? textStreamResult(`Weather report ${child} ready.`)
            : toolCallsStreamResult([
                {
                  input: JSON.stringify({ city: `Lisbon ${child}` }),
                  toolCallId: `call_weather_${child}`,
                  toolName: "get_weather",
                },
              ]);
        }
        if (!called("agent"))
          return toolCallsStreamResult(
            Array.from({ length: children }, (_, index) => ({
              input: JSON.stringify({ message: `CHILD ${index}: check the weather in Lisbon.` }),
              toolCallId: `call_agent_${index}`,
              toolName: "agent",
            })),
          );
        if (parentAsks !== false && !called("get_weather"))
          return toolCallsStreamResult([
            {
              input: JSON.stringify({ city: "Lisbon parent" }),
              toolCallId: "call_weather_parent",
              toolName: "get_weather",
            },
          ]);
        const reports = raw.match(/Weather report \d ready/gu)?.length ?? 0;
        if (reports < children) {
          if (waits > 20) throw new Error("The parent kept waiting for its children.");
          return toolCallsStreamResult([
            { input: "{}", toolCallId: `call_wait_${waits++}`, toolName: "eve__task_wait" },
          ]);
        }
        return textStreamResult("Every child reported.");
      },
      modelId: "scripted",
      provider: "eve-test",
    }),
  );
}

/**
 * Connect is faked at its edge: a callback with a `code` stores the grant, and a token is read
 * from the stored grant. With `again`, the grant is revoked when child 0 asks for Porto's weather.
 */
async function createApp(
  name: string,
  options: {
    readonly again?: boolean;
    readonly children?: number;
    /** The token exchange for a callback with a code throws this, as a provider outage would. */
    readonly exchangeFails?: string;
    readonly grant?: string;
    /** The last child asks for its token only after `releaseLate`. */
    readonly lateChild?: boolean;
    /** The parent's own tool needs the sign-in too; with `first`, the children ask after it. */
    readonly parentAsks?: boolean | "first";
    /** The first call to get a token holds until `release`, as a long command would. */
    readonly holdFirst?: boolean;
  },
) {
  let holding = false;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let othersRan = () => {};
  const others = new Promise<void>((resolve) => {
    othersRan = resolve;
  });
  let granted = false;
  let revoked = false;
  // With `parentAsks: "first"`, the children ask once the test has seen the parent's card.
  let releaseChildren = () => {};
  const childrenAsk = new Promise<void>((resolve) => {
    releaseChildren = resolve;
  });
  let releaseLate = () => {};
  const lateJoins = new Promise<void>((resolve) => {
    releaseLate = resolve;
  });
  let starts = 0;
  let completes = 0;
  const callbacks: Readonly<Record<string, string>>[] = [];
  const executions: string[] = [];
  const weatherAuth: AuthorizationDefinition<{ nonce: string }> = {
    principalType: "user",
    ...(options.grant !== undefined && { vercelConnect: { connector: options.grant } }),
    async getToken(): Promise<TokenResult> {
      if (granted) return { token: "weather-token" };
      throw new ConnectionAuthorizationRequiredError("weather");
    },
    async startAuthorization({ callbackUrl }) {
      starts += 1;
      return {
        challenge: {
          displayName: "Weather",
          instructions: "Sign in to continue.",
          url: `https://idp.example/authorize?callback=${encodeURIComponent(callbackUrl)}`,
        },
        resume: { nonce: "weather-nonce" },
      };
    },
    async completeAuthorization({ callback }): Promise<TokenResult> {
      completes += 1;
      callbacks.push(callback.params);
      if (options.exchangeFails !== undefined && callback.params.code !== undefined)
        throw new Error(options.exchangeFails);
      if (callback.params.code !== undefined) granted = true;
      if (!granted)
        throw new ConnectionAuthorizationFailedError("weather", {
          message: "The sign-in didn't finish, so you do not have access yet.",
        });
      return { token: "weather-token" };
    },
  };
  const runtime = await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamic(() => ({
          model: scriptedModel(
            options.children ?? CHILDREN,
            options.again === true,
            options.parentAsks ?? false,
          ),
          modelContextWindowTokens: 200_000,
        })),
      }),
      name,
    },
    modules: [
      {
        loadNamespace: async () => ({
          default: defineTool({
            description: "Get the weather for a city.",
            async execute(input, ctx) {
              if (options.parentAsks === "first" && input.city !== "Lisbon parent")
                await childrenAsk;
              if (
                options.lateChild === true &&
                input.city === `Lisbon ${(options.children ?? CHILDREN) - 1}`
              )
                await lateJoins;
              const porto = input.city.startsWith("Porto");
              if (porto && !revoked) {
                revoked = true;
                granted = false;
              }
              const token = await ctx.getToken(weatherAuth, {
                authKey: porto ? "weather-porto" : "weather",
                displayName: "Weather",
              });
              if (options.holdFirst === true && !holding) {
                holding = true;
                await held;
              }
              executions.push(input.city);
              if (holding && executions.length === (options.children ?? CHILDREN) - 1) othersRan();
              return { city: input.city, summary: `authorized with ${token.token}` };
            },
            inputSchema: z.object({ city: z.string() }),
          }),
        }),
        logicalPath: "tools/get_weather.ts",
      },
    ],
  });
  return {
    callbacks: () => callbacks,
    completes: () => completes,
    executions: () => executions,
    othersRan: () => others,
    release: () => release(),
    releaseChildren,
    releaseLate: () => releaseLate(),
    name,
    runtime,
    starts: () => starts,
  };
}

async function startParent(name: string) {
  return await startSessionOwner(workflowEntry, [
    {
      kind: "initial",
      ownerDeploymentId: "dpl_inline",
      input: { message: "Ask three helpers for the weather in Lisbon." },
      serializedContext: {
        ...buildSerializedContext({
          auth: ALICE,
          channelKind: "http",
          continuationToken: `http:${name}`,
        }),
        "eve.capabilities": { requestInput: true },
      },
    },
  ]);
}

/** Calls the callback URL a sign-in card names, as the provider redirects back to it. */
async function completeSignIn(
  card: SessionStreamEvent,
  params: Readonly<Record<string, string>>,
): Promise<void> {
  if (card.type !== "interaction.opened") throw new Error("Expected a sign-in card.");
  const callbackUrl = card.data.request.signIn?.callbackUrl;
  if (callbackUrl === undefined) throw new Error("Expected the sign-in to name its callback.");
  const callback = parseEveConnectionCallbackRoutePath(new URL(callbackUrl).pathname);
  if (callback === undefined) throw new Error(`Expected a callback route: ${callbackUrl}`);
  await resumeAuthorizationCallback(callback.token, {
    kind: "authorization-callback",
    payloads: [
      {
        authorizationCallback: {
          attemptId: callback.attemptId,
          callback: { method: "GET", params },
          connectionName: callback.name,
        },
      },
    ],
  });
}

function isSignInOpened(event: SessionStreamEvent): boolean {
  return event.type === "interaction.opened" && event.data.request.kind === "sign-in";
}

/** A sign-in a channel shows a card for: one that waits on no card already shown. */
function isShownCard(card: SessionStreamEvent): boolean {
  return waitsOnOf(card) === undefined;
}

function waitsOnOf(card: SessionStreamEvent): string | undefined {
  if (card.type !== "interaction.opened") throw new Error("Expected a sign-in card.");
  return card.data.request.signIn?.waitsOn;
}

/** A sign-in the parent asked itself, rather than one it relays for a child. */
function isOwnSignIn(card: SessionStreamEvent): boolean {
  return card.type === "interaction.opened" && card.data.origin === undefined;
}

function isTurnSettled(event: SessionStreamEvent): boolean {
  return event.type === "turn.settled";
}

function signInId(event: SessionStreamEvent): string {
  if (event.type !== "interaction.opened") throw new Error("Expected a sign-in card.");
  return event.data.interactionId;
}
