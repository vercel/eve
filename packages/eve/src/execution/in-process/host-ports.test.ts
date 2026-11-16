import { isHookConflictError } from "#execution/hook-ownership.js";
import { describe, expect, it } from "vitest";

import type { SessionCommand } from "#channel/types.js";
import { createSessionInbox } from "#execution/session-inbox/inbox.js";
import { createMemoryInboxRegistry } from "./inbox-transport.js";
import { createMemoryLineStore } from "./line-store.js";
import { structuredCloneBoundary } from "./step-boundary.js";

const send = (text: string): SessionCommand => ({ kind: "send", payload: { message: text } });

async function chunksOf(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(decoder.decode(chunk));
  return chunks;
}

describe("the in-process line store", () => {
  it("keeps each line as written, and follows a stream until its writer closes it", async () => {
    const store = createMemoryLineStore();
    const writer = store.open("session-alice").getWriter();
    const encoder = new TextEncoder();
    const buffer = encoder.encode("alice\n");
    await writer.write(buffer);
    // The writer may reuse its buffer.
    buffer.set(encoder.encode("bob!!\n"));
    await expect(store.tail("session-alice")).resolves.toBe(0);

    const following = chunksOf(store.readable("session-alice"));
    await writer.write(encoder.encode("carol\n"));
    await writer.close();

    await expect(following).resolves.toEqual(["alice\n", "carol\n"]);
    await expect(chunksOf(store.readable("session-alice", -1))).resolves.toEqual(["carol\n"]);
    await expect(store.assertReadable("session-bob")).rejects.toThrow(
      'Session "session-bob" has no stream here.',
    );
  });
});

describe("the in-process inbox transport", () => {
  it("delivers to the session that holds an address, in order", async () => {
    const registry = createMemoryInboxRegistry(structuredCloneBoundary);
    const inbox = createSessionInbox(registry.transportFor("session-alice"));
    await expect(registry.deliver("alice", send("before"))).resolves.toBeUndefined();

    await inbox.claimSessionHook("alice");
    expect(registry.holder("alice")).toBe("session-alice");
    await expect(registry.deliver("alice", send("first"))).resolves.toEqual({
      kind: "delivered",
      owner: "session-alice",
    });
    await registry.deliver("alice", send("second"));

    await expect(inbox.next()).resolves.toEqual(send("first"));
    await expect(inbox.next()).resolves.toEqual(send("second"));
    await inbox.dispose();
    expect(registry.holder("alice")).toBeUndefined();
  });

  it("refuses an address another session holds", async () => {
    const registry = createMemoryInboxRegistry(structuredCloneBoundary);
    const alice = createSessionInbox(registry.transportFor("session-alice"));
    const bob = createSessionInbox(registry.transportFor("session-bob"));
    await alice.claimSessionHook("shared");
    // The conflict the core recognizes, so the session that lost joins the one that holds it.
    const conflict = await bob.claimSessionHook("shared").catch((error: unknown) => error);
    expect(isHookConflictError(conflict)).toBe(true);
    expect(conflict).toMatchObject({ conflictingRunId: "session-alice", token: "shared" });
    await alice.dispose();
    await bob.dispose();
  });

  it("hands each delivery over at once by default", async () => {
    const registry = createMemoryInboxRegistry(structuredCloneBoundary);
    const inbox = createSessionInbox(registry.transportFor("session-alice"));
    await inbox.claimSessionHook("alice");
    const next = inbox.next();
    await registry.deliver("alice", send("first"));
    await expect(next).resolves.toEqual(send("first"));
    await inbox.dispose();
  });

  it("holds batched deliveries until the next macrotask, then hands them over in order", async () => {
    const registry = createMemoryInboxRegistry(structuredCloneBoundary, { deliveries: "batched" });
    const inbox = createSessionInbox(registry.transportFor("session-alice"));
    await inbox.claimSessionHooks(["alice", "alice-commands"]);
    const compact: SessionCommand = { deliveryId: "compact-1", kind: "compact" };
    const clear: SessionCommand = { deliveryId: "clear-1", kind: "clear" };

    // Back to back, to two of the session's addresses: two commands, then a message behind them.
    await registry.deliver("alice-commands", compact);
    await registry.deliver("alice-commands", clear);
    await registry.deliver("alice", send("Bob asks again."));
    expect(inbox.hasPending()).toBe(false);

    await registry.heard();
    expect(inbox.drain()).toEqual([compact, clear, send("Bob asks again.")]);
    await inbox.dispose();
  });

  it("ends every reader when the registry closes", async () => {
    const registry = createMemoryInboxRegistry(structuredCloneBoundary);
    const inbox = createSessionInbox(registry.transportFor("session-alice"));
    await inbox.claimSessionHook("alice");
    const next = inbox.next();
    registry.closeAll();
    await expect(next).resolves.toBeUndefined();
  });
});
