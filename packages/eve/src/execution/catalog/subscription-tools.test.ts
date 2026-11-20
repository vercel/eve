import { expect, it, vi } from "vitest";

import { connectionToolName } from "#connections/ownership.js";
import { eventActionName } from "#runtime/subscriptions/actions.js";
import { SUBSCRIBE_TOOL } from "#runtime/subscriptions/tools.js";
import { serializeInputSchema } from "#tools/schema.js";

import { subscriptionTools } from "./subscription-tools.js";
import type { Callable } from "./step-catalog.js";

const held = vi.hoisted(() => ({ bindings: new Map<string, unknown>() }));
vi.mock("#execution/hosts.js", () => ({
  installedDurableHost: () => ({
    subscriptions: {
      find: async (id: string) => {
        const binding = held.bindings.get(id);
        return binding === undefined ? undefined : { binding };
      },
    },
  }),
}));

const channel = (name: string) => ({ name, definition: { onEvent: () => null } });
const tracker = {
  approval: () => "denied",
  connectionName: "tracker",
  description: "Issue tracker updates.",
  experimental_events: {},
};
const plain = { connectionName: "docs" };

const callable = (input: { channels?: unknown[]; connections?: unknown[] }) => ({
  channels: (input.channels ?? []) as Callable["channels"],
  connections: (input.connections ?? []) as Callable["connections"],
  registry: {
    getClient: () => {
      throw new Error("No client in this test.");
    },
  } as never,
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
  expect([...offered.keys()]).toEqual([
    "eve__subscribe",
    "eve__subscription_get",
    "eve__subscription_stop",
  ]);

  const subscribe = offered.get("eve__subscribe")!;
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
  expect(subscribe.route?.owns?.map(({ name }) => name)).toEqual([SUBSCRIBE_TOOL]);
});

it("offers the management tools and a route without a private entry for connections only", () => {
  const subscribe = tools({ connections: [tracker] }).get("eve__subscribe")!;
  expect(subscribe.route?.owns).toEqual([]);
});

const input = (subscription: unknown, ttlMs: number | null = 120_000) => ({ subscription, ttlMs });

it("routes a channel's event to the entry that opens a channel subscription, input unchanged", () => {
  const { route } = tools({
    channels: [channel("github")],
    connections: [tracker],
  }).get("eve__subscribe")!;
  const call = input({
    source: "github",
    event: "check_suite.completed",
    input: { owner: "vercel", pull: 7 },
  });
  expect(route!.target(call)).toEqual({ input: call, name: SUBSCRIBE_TOOL });
});

it("routes a connection's event to that connection's generated tool for it", () => {
  const { route } = tools({ connections: [tracker] }).get("eve__subscribe")!;
  expect(
    route!.target(input({ source: "tracker", event: "issue.created", input: { team: "eng" } })),
  ).toEqual({
    input: { arguments: { team: "eng" }, ttlMs: 120_000 },
    name: connectionToolName("tracker", eventActionName("issue.created")),
  });
});

it("does not route a source that offers no subscriptions", () => {
  const { route } = tools({ connections: [tracker] }).get("eve__subscribe")!;
  expect(route!.target(input({ source: "docs", event: "x", input: {} }))).toMatchObject({
    issue: 'No source named "docs" offers subscriptions.',
  });
  expect(route!.target({})).toMatchObject({ issue: "Name the source to subscribe to." });
});

it("reports a connection event's argument problems under subscription.input", () => {
  const { route } = tools({ connections: [tracker] }).get("eve__subscribe")!;
  const issues = route!.explain!({} as never, [
    { message: "team is required", path: ["arguments", "team"] },
    { message: "ttl too short", path: ["ttlMs"] },
  ]);
  expect(issues).toEqual([
    { message: "team is required", path: ["subscription", "input", "team"] },
    { message: "ttl too short", path: ["ttlMs"] },
  ]);
});

it("rejects a channel and a connection of one name that both offer subscriptions", () => {
  expect(() => tools({ channels: [channel("tracker")], connections: [tracker] })).toThrow(
    'A channel and a connection are both named "tracker"',
  );
  expect(() => tools({ channels: [channel("tracker")], connections: [plain] })).not.toThrow();
});

it("marks each tool a framework tool that subagents are not offered", () => {
  const offered = tools({ channels: [channel("github")], connections: [tracker] });
  for (const { definition } of offered.values()) {
    expect(definition.frameworkTool).toBe(true);
    expect(definition.rootOnly).toBe(true);
  }
});

const approvalContext = (id: unknown) =>
  ({
    abortSignal: new AbortController().signal,
    callId: "c1",
    toolInput: { id },
    toolName: "x",
  }) as never;

it("gets and stops a connection's subscription under that connection's approval policy", async () => {
  held.bindings.set("conn-sub", { source: { kind: "connection", name: "tracker" } });
  held.bindings.set("chan-sub", { source: { kind: "channel", name: "github" } });
  const offered = tools({ channels: [channel("github")], connections: [tracker] });
  for (const name of ["eve__subscription_get", "eve__subscription_stop"]) {
    const approval = offered.get(name)!.definition.approval as {
      request: (context: never) => unknown;
    };
    expect(await approval.request(approvalContext("conn-sub"))).toBe("denied");
    expect(await approval.request(approvalContext("chan-sub"))).toBeUndefined();
    expect(await approval.request(approvalContext("unknown"))).toBeUndefined();
  }
});

it("lets only the requester answer a management approval unless the connection's response policy says otherwise", async () => {
  held.bindings.set("conn-sub", { source: { kind: "connection", name: "tracker" } });
  const responder = { principalId: "other", principalType: "user", authenticator: "a" };
  const context = (requester: unknown) =>
    ({
      request: { callId: "c1", principal: requester, toolInput: { id: "conn-sub" }, toolName: "x" },
      response: { decision: "approve", principal: responder },
    }) as never;
  const response = (
    tools({ connections: [tracker] }).get("eve__subscription_stop")!.definition.approval as {
      response: (context: never) => Promise<{ status: string }>;
    }
  ).response;
  expect(await response(context(responder))).toEqual({ status: "allowed" });
  expect(await response(context({ ...responder, principalId: "requester" }))).toMatchObject({
    status: "rejected",
  });
});

it("reports a connection subscription unknown when the session has no such connection", async () => {
  held.bindings.set("gone-sub", { source: { kind: "connection", name: "gone" } });
  const offered = tools({ connections: [tracker] });
  for (const name of ["eve__subscription_get", "eve__subscription_stop"]) {
    await expect(
      offered.get(name)!.definition.execute!({ id: "gone-sub" } as never, {} as never),
    ).rejects.toThrow("Unknown subscription for this caller.");
  }
});
