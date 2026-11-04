import { describe, expect, it } from "vitest";

import type { SessionCommand } from "#channel/types.js";
import { createSessionInbox } from "#execution/session-inbox/inbox.js";
import { createMemoryInboxRegistry } from "./inbox-transport.js";
import { createMemoryLineStore } from "./line-store.js";

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
    const registry = createMemoryInboxRegistry();
    const inbox = createSessionInbox(registry.transportFor("session-alice"));
    expect(registry.deliver("alice", send("before"))).toBeUndefined();

    await inbox.claimSessionHook("alice");
    expect(registry.holder("alice")).toBe("session-alice");
    expect(registry.deliver("alice", send("first"))).toEqual({ sessionId: "session-alice" });
    registry.deliver("alice", send("second"));

    await expect(inbox.next()).resolves.toEqual(send("first"));
    await expect(inbox.next()).resolves.toEqual(send("second"));
    await inbox.dispose();
    expect(registry.holder("alice")).toBeUndefined();
  });

  it("refuses an address another session holds", async () => {
    const registry = createMemoryInboxRegistry();
    const alice = createSessionInbox(registry.transportFor("session-alice"));
    const bob = createSessionInbox(registry.transportFor("session-bob"));
    await alice.claimSessionHook("shared");
    await expect(bob.claimSessionHook("shared")).rejects.toThrow(
      'Session address "shared" belongs to another session.',
    );
    await alice.dispose();
    await bob.dispose();
  });

  it("ends every reader when the registry closes", async () => {
    const registry = createMemoryInboxRegistry();
    const inbox = createSessionInbox(registry.transportFor("session-alice"));
    await inbox.claimSessionHook("alice");
    const next = inbox.next();
    registry.closeAll();
    await expect(next).resolves.toBeUndefined();
  });
});
