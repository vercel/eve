import { describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";

import { accumulate, memoryToolsDefinition, resolveMemoryScope } from "./definition.js";

const recalled = (turnId: string, overrides: { cleared?: number; scope?: string } = {}) => ({
  cleared: overrides.cleared ?? null,
  result: null,
  scope: overrides.scope ?? "alice",
  turnId,
});

describe("accumulate", () => {
  it("keeps earlier turns' recalls, and replaces what an id recalled before", () => {
    const first = accumulate(null, recalled("turn_0"), [
      { content: "Prefers Spanish.", itemKey: "language" },
      { content: "Asked about invoices." },
    ]);
    const second = accumulate(first as never, recalled("turn_1"), [
      { content: "Prefers French.", itemKey: "language" },
      { content: "Asked about refunds." },
    ]);

    expect(second.batches).toEqual([
      { messages: [{ content: "Asked about invoices." }], turnId: "turn_0" },
      {
        messages: [
          { content: "Prefers French.", id: "language" },
          { content: "Asked about refunds." },
        ],
        turnId: "turn_1",
      },
    ]);
  });

  it("leaves an id's message where it was when its content is the same", () => {
    const first = accumulate(null, recalled("turn_0"), [
      { content: "Prefers Spanish.", itemKey: "language" },
    ]);
    const second = accumulate(first as never, recalled("turn_1"), [
      { content: "Prefers Spanish.", itemKey: "language" },
    ]);

    expect(second.batches).toEqual(first.batches);
  });

  it("replaces a turn's recall when that turn recalls again", () => {
    const first = accumulate(null, recalled("turn_0"), [{ content: "Once." }]);
    const again = accumulate(first as never, recalled("turn_0"), [{ content: "Once." }]);

    expect(again.batches).toEqual([{ messages: [{ content: "Once." }], turnId: "turn_0" }]);
  });

  it("starts over after a clear or under another scope", () => {
    const first = accumulate(null, recalled("turn_0"), [{ content: "Alice's note." }]);
    const cleared = accumulate(first as never, recalled("turn_1", { cleared: 7 }), [
      { content: "After the clear." },
    ]);
    const bob = accumulate(first as never, recalled("turn_1", { scope: "bob" }), [
      { content: "Bob's note." },
    ]);

    expect(cleared.batches).toEqual([
      { messages: [{ content: "After the clear." }], turnId: "turn_1" },
    ]);
    expect(bob.batches).toEqual([{ messages: [{ content: "Bob's note." }], turnId: "turn_1" }]);
  });
});

describe("memoryToolsDefinition", () => {
  it("keeps a memory's tools under the ID of the tool file eve generated for them", () => {
    // Sessions hold their slot, memos, and the versions parked approvals compare under this ID.
    const definition = memoryToolsDefinition({
      logicalPath: "memory/profile.ts",
      offersTools: true,
      provider: { recall: {} },
      slot: "profile",
      sourceId: "memory/profile.ts",
      sourceKind: "module",
    } as never);

    expect(definition.id).toBe("tool::profile");
  });
});

describe("resolveMemoryScope", () => {
  it("lets a scope resolver key memory by the conversation's space", async () => {
    const conversation = {
      audience: "private",
      channel: { kind: "channel:slack", name: "slack" },
      environment: "production",
      principalType: "user",
      space: { id: "slack:T1:C1", type: "channel", workspaceId: "slack:T1" },
    } as const;

    const resolver = vi.fn(
      (ctx: { conversation?: typeof conversation }) => ctx.conversation?.space?.id ?? null,
    );
    const scope = await resolveMemoryScope(
      { namespace: "team", scope: resolver as never, slot: "notes" },
      {
        abortSignal: new AbortController().signal,
        channel: { kind: "channel:slack", metadata: {} },
        conversation,
        ctx: new ContextContainer() as never,
        session: { auth: { current: null, initiator: null }, id: "session-1" },
      },
    );

    expect(resolver).toHaveReturnedWith("slack:T1:C1");
    expect(scope).not.toBeNull();
  });
});
