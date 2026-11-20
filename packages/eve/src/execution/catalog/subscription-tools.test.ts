import { expect, it } from "vitest";

import { connectionToolName } from "#connections/ownership.js";
import { eventActionName } from "#runtime/subscriptions/actions.js";
import { CHANNEL_SUBSCRIBE_ENTRY } from "#runtime/subscriptions/tools.js";
import { serializeInputSchema } from "#tools/schema.js";

import { subscriptionTools } from "./subscription-tools.js";
import type { Callable } from "./step-catalog.js";

const channel = (name: string) => ({ name, definition: { onEvent: () => true } });
const tracker = {
  connectionName: "tracker",
  description: "Issue tracker updates.",
  experimental_events: {},
};
const plain = { connectionName: "docs" };

const callable = (input: { channels?: unknown[]; connections?: unknown[] }) => ({
  channels: (input.channels ?? []) as Callable["channels"],
  connections: (input.connections ?? []) as Callable["connections"],
});
const tools = (input: Parameters<typeof callable>[0]) => subscriptionTools(callable(input));

it("offers nothing when no channel has subscriptions and no connection emits events", () => {
  expect(tools({}).size).toBe(0);
  expect(tools({ channels: [{ name: "slack", definition: {} }], connections: [plain] }).size).toBe(
    0,
  );
});

it("offers one subscribe, get and stop for channels and connections together", () => {
  const offered = tools({
    channels: [channel("github")],
    connections: [tracker, plain],
  });
  expect([...offered.keys()]).toEqual(["subscribe", "get_subscription", "stop_subscription"]);

  const subscribe = offered.get("subscribe")!;
  const schema = serializeInputSchema(subscribe.definition.inputSchema as never) as {
    properties: { subscription: { anyOf: { properties: Record<string, unknown> }[] } };
  };
  const [github, tracked] = schema.properties.subscription.anyOf.map(
    ({ properties }) => properties,
  );
  expect(github).toMatchObject({
    source: { const: "github" },
    event: { type: "string" },
    input: { type: "object" },
  });
  expect(tracked).toMatchObject({
    source: { enum: ["tracker"] },
    event: { type: "string" },
    input: { type: "object" },
  });
  expect(subscribe.definition.description).toContain("Channel github:");
  expect(subscribe.definition.description).toContain("Connection tracker: Issue tracker updates.");
  expect(subscribe.definition.description).not.toContain("docs");
  expect(subscribe.route?.owns?.map(({ name }) => name)).toEqual([CHANNEL_SUBSCRIBE_ENTRY]);
});

it("offers the management tools and a route without a private entry for connections only", () => {
  const subscribe = tools({ connections: [tracker] }).get("subscribe")!;
  expect(subscribe.route?.owns).toEqual([]);
});

const input = (subscription: unknown, ttlMs: number | null = 120_000) => ({ subscription, ttlMs });

it("routes a channel's event to the entry that opens a channel subscription, input unchanged", () => {
  const { route } = tools({
    channels: [channel("github")],
    connections: [tracker],
  }).get("subscribe")!;
  const call = input({
    source: "github",
    event: "check_suite.completed",
    input: { owner: "vercel", pull: 7 },
  });
  expect(route!.target(call)).toEqual({ input: call, name: CHANNEL_SUBSCRIBE_ENTRY });
});

it("routes a connection's event to that connection's generated tool for it", () => {
  const { route } = tools({ connections: [tracker] }).get("subscribe")!;
  expect(
    route!.target(input({ source: "tracker", event: "issue.created", input: { team: "eng" } })),
  ).toEqual({
    input: { arguments: { team: "eng" }, ttlMs: 120_000 },
    name: connectionToolName("tracker", eventActionName("issue.created")),
  });
});

it("does not route a source that offers no subscriptions", () => {
  const { route } = tools({ connections: [tracker] }).get("subscribe")!;
  expect(route!.target(input({ source: "docs", event: "x", input: {} }))).toMatchObject({
    issue: 'No source named "docs" offers subscriptions.',
  });
  expect(route!.target({})).toMatchObject({ issue: "Name the source to subscribe to." });
});

it("reports a connection event's argument problems under subscription.input", () => {
  const { route } = tools({ connections: [tracker] }).get("subscribe")!;
  const issues = route!.explain!({} as never, [
    { message: "team is required", path: ["arguments", "team"] },
    { message: "ttl too short", path: ["ttlMs"] },
  ]);
  expect(issues).toEqual([
    { message: "team is required", path: ["subscription", "input", "team"] },
    { message: "ttl too short", path: ["ttlMs"] },
  ]);
});
