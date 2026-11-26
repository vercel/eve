import { beforeEach, expect, it, vi } from "vitest";

import { z } from "zod";

import { channelEventKey } from "./keys.js";

const host = vi.hoisted(() => ({ emit: vi.fn() }));
vi.mock("#execution/hosts.js", () => ({
  installedDurableHost: () => ({ subscriptions: { emit: host.emit } }),
}));

const { createEmitChannelEventFn } = await import("./emit.js");

const events = [
  {
    name: "build.failed",
    description: "A build failed.",
    inputSchema: z.strictObject({ project: z.string() }),
  },
];
const catalog = async () => events;
const occurrence = { id: "o1", data: {} };
const artifacts = { kind: "disk", appRoot: "/virtual" } as const;

beforeEach(() => {
  host.emit.mockReset().mockResolvedValue(true);
});

it("hands a declared event to the subscriptions holding its scope", async () => {
  const emit = createEmitChannelEventFn("ci", catalog, () => artifacts);

  await expect(emit("build.failed", { project: "web" }, occurrence)).resolves.toBe(true);

  expect(host.emit).toHaveBeenCalledWith(
    "ci",
    channelEventKey("build.failed", { project: "web" }),
    occurrence,
    artifacts,
  );
});

it("throws for an event the channel does not declare, naming the closest ones", async () => {
  const emit = createEmitChannelEventFn("ci", catalog, () => artifacts);

  await expect(emit("build.faild", { project: "web" }, occurrence)).rejects.toThrow(
    'Channel "ci" does not declare the event "build.faild"',
  );
  await expect(emit("build.faild", { project: "web" }, occurrence)).rejects.toThrow(
    "Closest events: build.failed.",
  );
  expect(host.emit).not.toHaveBeenCalled();
});

it("throws when the scope does not match the event's input schema", async () => {
  const emit = createEmitChannelEventFn("ci", catalog, () => artifacts);

  await expect(emit("build.failed", { repo: "web" }, occurrence)).rejects.toThrow(
    'Subscription input does not match the schema of "build.failed"',
  );
  expect(host.emit).not.toHaveBeenCalled();
});

it("throws when the channel declares no events at all", async () => {
  await expect(
    createEmitChannelEventFn("ci", undefined, () => artifacts)(
      "build.failed",
      { project: "web" },
      occurrence,
    ),
  ).rejects.toThrow('Channel "ci" does not declare the event "build.failed"');
});
