import { expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { resolveApprovalPolicy } from "#approval/definition.js";
import { evaluateApproval } from "#approval/evaluation.js";
import { once } from "#tools/approval/policies.js";

import { defineJsonSchema, serializeInputSchema } from "#tools/schema.js";

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

const channel = (name: string) => ({
  name,
  definition: { onEvent: () => null, catalog: () => [] },
});
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
  agentApproval: undefined,
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
    source: { type: "string" },
    event: { type: "string" },
    input: { type: "object" },
  });
  expect(subscribe.route).toBeUndefined();
  expect(subscribe.definition.description).toContain("eve__search");
  expect(subscribe.definition.description).not.toContain("github");
  expect(subscribe.definition.description).not.toContain("tracker");
});

it("keeps eve__subscribe's schema and description the same however many events a channel emits", () => {
  const events = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      name: `event_${index}`,
      description: `Event ${index}.`,
      inputSchema: defineJsonSchema({ type: "object" }),
    }));
  const subscribe = (count: number) =>
    tools({
      channels: [
        { name: "github", definition: { onEvent: () => null, catalog: () => events(count) } },
      ],
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

it("offers no connection source under an allow list that names no event subscription", () => {
  const sources = (tools: unknown) =>
    subscriptionSources(callable({ connections: [{ ...tracker, tools }] })).connections;
  expect(sources({ allow: ["list_issues"] })).toEqual([]);
  expect(sources({ allow: ["list_issues", "events_subscribe_issue.created"] })).toHaveLength(1);
  expect(sources({ block: ["list_issues"] })).toHaveLength(1);
  expect(sources(undefined)).toHaveLength(1);
});

it("offers a subagent no subscription source, search result or tool", () => {
  const input = { channels: [channel("github")], connections: [tracker], subagent: true };
  expect(tools(input).size).toBe(0);
  expect(subscriptionSources(callable(input))).toEqual({ channels: [], connections: [] });
  expect(
    catalogReach({ ...callable(input), deferred: new Map(), skills: new Map() } as never),
  ).toMatchObject({ subscriptions: false });
});

it("rejects a source that no channel or connection offers and points to eve__search", () => {
  const subscribe = tools({ channels: [channel("github")], connections: [tracker] }).get(
    "eve__subscribe",
  )!.definition;
  expect(() =>
    subscribe.execute!(
      { source: "docs", event: "push", input: {}, ttlMs: null },
      { messages: [], toolCallId: "c" },
    ),
  ).toThrow('Unknown subscription source "docs". Find sources and their events with eve__search.');
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

it("keeps a remembered once() approval to the connection and the event or subscription it was given for", async () => {
  const gated = (name: string) => ({ ...tracker, connectionName: name, approval: once() });
  const offered = tools({ connections: [gated("a"), gated("b")] });
  const decide = async (
    tool: string,
    toolInput: unknown,
    remembered: Record<string, { outcome: "accepted"; interactionId: string }> = {},
  ) => {
    const request = resolveApprovalPolicy(offered.get(tool)!.definition.approval!);
    return contextStorage.run(new ContextContainer(), () =>
      evaluateApproval(
        request,
        {
          abortSignal: new AbortController().signal,
          callId: "c1",
          toolInput,
          toolName: tool,
        } as never,
        { memory: { pending: [], remembered } },
      ),
    );
  };
  const given = async (tool: string, toolInput: unknown) => {
    const asked = await decide(tool, toolInput);
    return { [asked.remember!.key]: { outcome: "accepted" as const, interactionId: "i1" } };
  };
  const subscribeA = { source: "a", event: "issue.closed", input: {}, ttlMs: null };
  const remembered = await given("eve__subscribe", subscribeA);
  expect(await decide("eve__subscribe", subscribeA, remembered)).toMatchObject({ denied: false });
  const others = [
    { ...subscribeA, source: "b" },
    { ...subscribeA, event: "issue.opened" },
  ];
  for (const other of others) {
    expect((await decide("eve__subscribe", other, remembered)).awaitsPerson).toBe(true);
  }
  held.bindings.set("sub-a", { id: "sub-a", source: { kind: "connection", name: "a" } });
  held.bindings.set("sub-a2", { id: "sub-a2", source: { kind: "connection", name: "a" } });
  held.bindings.set("sub-b", { id: "sub-b", source: { kind: "connection", name: "b" } });
  const stopped = await given("eve__subscription_stop", { id: "sub-a" });
  expect(await decide("eve__subscription_stop", { id: "sub-a" }, stopped)).toMatchObject({
    denied: false,
  });
  for (const id of ["sub-a2", "sub-b"]) {
    expect((await decide("eve__subscription_stop", { id }, stopped)).awaitsPerson).toBe(true);
  }
});

const promptContext = (input: Record<string, unknown>) =>
  ({ callId: "c1", input, toolName: "eve__subscribe" }) as never;

it("tells the approver the source, event, input and lifetime unless the connection authors its own prompt", () => {
  const prompt = (connection: unknown, input: Record<string, unknown>) =>
    (
      tools({ connections: [connection] }).get("eve__subscribe")!.definition.approval as {
        prompt: (context: never) => string;
      }
    ).prompt(promptContext(input));
  const input = {
    source: "tracker",
    event: "issue.closed",
    input: { repo: "a/b" },
    ttlMs: 3_600_000,
  };
  expect(prompt(tracker, input)).toBe(
    'Subscribe to "issue.closed" events from "tracker" for 1h, with input {"repo":"a/b"}?',
  );
  expect(prompt(tracker, { ...input, ttlMs: null })).toContain("until stopped");
  const authored = {
    ...tracker,
    approval: {
      request: () => "denied",
      prompt: ({ toolName }: { toolName: string }) => `Allow ${toolName}?`,
    },
  };
  expect(prompt(authored, input)).toBe("Allow eve__subscribe?");
});

it("names the subscription a stop approval is about", () => {
  const approval = tools({ connections: [tracker] }).get("eve__subscription_stop")!.definition
    .approval as { prompt: (context: never) => string };
  expect(approval.prompt(promptContext({ id: "conn-sub" }))).toBe('Stop subscription "conn-sub"?');
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
