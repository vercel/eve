import { expect, it } from "vitest";
import {
  channelEventKey,
  channelSubscriptionId,
  connectionSubscriptionId,
  deliveryIdempotencyKey,
  openIdempotencyKey,
} from "./keys.js";

const connection = {
  sessionId: "s1",
  instanceId: undefined,
  connectionName: "tracker",
  owner: "user:1",
  executionPrincipal: "p1",
  event: "issue.updated",
  arguments: { project: "web", labels: ["a"] },
} as const;

it("derives an event key from the event and its input regardless of key order", () => {
  expect(channelEventKey("push", { owner: "vercel", repo: "eve" })).toBe(
    channelEventKey("push", { repo: "eve", owner: "vercel" }),
  );
  expect(channelEventKey("push", { owner: "vercel" })).not.toBe(
    channelEventKey("pull_request", { owner: "vercel" }),
  );
});

it("gives a channel binding a different id for each session and principal", () => {
  const base = { channelName: "github", key: "k", sessionId: "s1", executionPrincipal: "p1" };
  expect(channelSubscriptionId(base)).toBe(channelSubscriptionId({ ...base }));
  expect(channelSubscriptionId({ ...base, sessionId: "s2" })).not.toBe(channelSubscriptionId(base));
  expect(channelSubscriptionId({ ...base, executionPrincipal: "p2" })).not.toBe(
    channelSubscriptionId(base),
  );
});

it("gives a connection binding the same id for the same arguments in any key order", () => {
  expect(
    connectionSubscriptionId({ ...connection, arguments: { labels: ["a"], project: "web" } }),
  ).toBe(connectionSubscriptionId(connection));
  expect(connectionSubscriptionId({ ...connection, arguments: { project: "api" } })).not.toBe(
    connectionSubscriptionId(connection),
  );
  expect(connectionSubscriptionId({ ...connection, instanceId: "i1" })).not.toBe(
    connectionSubscriptionId(connection),
  );
});

it("scopes the open key to the owner run and the delivery key to the event", () => {
  expect(openIdempotencyKey("b", "run-1")).not.toBe(openIdempotencyKey("b", "run-2"));
  expect(deliveryIdempotencyKey("b", "e1")).toMatch(/^eve:subscription:[0-9a-f]{64}$/);
  expect(deliveryIdempotencyKey("b", "e1")).not.toBe(deliveryIdempotencyKey("b", "e2"));
});
