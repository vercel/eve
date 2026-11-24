import { expect, it, vi } from "vitest";

import { serializeInputSchema } from "#tools/schema.js";

import { catalogReach } from "./catalog-tools.js";
import { subscriptionSources, subscriptionTools } from "./subscription-tools.js";
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

const channel = (name: string) => ({ name, definition: { onEvent: () => null, events: [] } });
const tracker = {
  approval: () => "denied",
  connectionName: "tracker",
  description: "Issue tracker updates.",
  experimental_events: {},
};
const plain = { connectionName: "docs" };

const callable = (input: {
  channels?: unknown[];
  connections?: unknown[];
  subagent?: boolean;
}) => ({
  subagent: input.subagent ?? false,
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

it("offers one flat subscribe and a stop for channels and connections together", () => {
  const offered = tools({
    channels: [channel("github")],
    connections: [tracker, plain],
  });
  expect([...offered.keys()]).toEqual(["eve__subscribe", "eve__subscription_stop"]);

  const subscribe = offered.get("eve__subscribe")!;
  const schema = serializeInputSchema(subscribe.definition.inputSchema as never) as {
    properties: Record<string, unknown>;
    required: string[];
  };
  expect(schema.required).toEqual(["source", "event", "input", "ttlMs"]);
  expect(schema.properties).toMatchObject({
    source: { enum: ["github", "tracker"] },
    event: { type: "string" },
    input: { type: "object" },
  });
  expect(subscribe.route).toBeUndefined();
  expect(subscribe.definition.description).toContain("github (channel");
  expect(subscribe.definition.description).toContain("tracker (connection)");
  expect(subscribe.definition.description).toContain("eve__search");
  expect(subscribe.definition.description).not.toContain("docs");
});

it("keeps eve__subscribe's schema and description the same however many events a channel emits", () => {
  const events = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      name: `event_${index}`,
      description: `Event ${index}.`,
      inputSchema: { type: "object" },
    }));
  const subscribe = (count: number) =>
    tools({
      channels: [{ name: "github", definition: { onEvent: () => null, events: events(count) } }],
    }).get("eve__subscribe")!.definition;
  const [few, many] = [subscribe(2), subscribe(300)];
  expect(JSON.stringify(serializeInputSchema(many.inputSchema as never))).toBe(
    JSON.stringify(serializeInputSchema(few.inputSchema as never)),
  );
  expect(many.description).toBe(few.description);
});

it("reaches eve__search for an agent whose only source is a channel with events", () => {
  const reach = catalogReach({
    ...callable({ channels: [channel("github")] }),
    deferred: new Map(),
    skills: new Map(),
  } as never);
  expect(reach).toMatchObject({ subscriptions: true, tools: false, connections: false });
  expect(
    catalogReach({ ...callable({}), deferred: new Map(), skills: new Map() } as never),
  ).toMatchObject({ subscriptions: false });
});

it("offers a subagent no subscription source, search result or tool", () => {
  const input = { channels: [channel("github")], connections: [tracker], subagent: true };
  expect(tools(input).size).toBe(0);
  expect(subscriptionSources(callable(input))).toEqual({ channels: [], connections: [] });
  expect(
    catalogReach({ ...callable(input), deferred: new Map(), skills: new Map() } as never),
  ).toMatchObject({ subscriptions: false });
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

it("subscribes under the source connection's approval policy", async () => {
  const approval = tools({ channels: [channel("github")], connections: [tracker] }).get(
    "eve__subscribe",
  )!.definition.approval as { request: (context: never) => unknown };
  const request = (source: string) =>
    approval.request({
      abortSignal: new AbortController().signal,
      callId: "c1",
      toolInput: { source },
      toolName: "x",
    } as never);
  expect(await request("tracker")).toBe("denied");
  expect(await request("github")).toBeUndefined();
});

it("stops a connection's subscription under that connection's approval policy", async () => {
  held.bindings.set("conn-sub", { source: { kind: "connection", name: "tracker" } });
  held.bindings.set("chan-sub", { source: { kind: "channel", name: "github" } });
  const offered = tools({ channels: [channel("github")], connections: [tracker] });
  const approval = offered.get("eve__subscription_stop")!.definition.approval as {
    request: (context: never) => unknown;
  };
  expect(await approval.request(approvalContext("conn-sub"))).toBe("denied");
  expect(await approval.request(approvalContext("chan-sub"))).toBeUndefined();
  expect(await approval.request(approvalContext("unknown"))).toBeUndefined();
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
  await expect(
    offered.get("eve__subscription_stop")!.definition.execute!(
      { id: "gone-sub" } as never,
      {} as never,
    ),
  ).rejects.toThrow("Unknown subscription for this caller.");
});
