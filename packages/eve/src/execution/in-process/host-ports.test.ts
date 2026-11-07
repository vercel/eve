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
    const kept: unknown[] = [];
    const inbox = createSessionInbox(
      registry.transportFor("session-alice", {
        keep: async (token, arrival) => {
          kept.push([token, arrival]);
        },
      }),
    );
    await expect(registry.deliver("alice", send("before"))).resolves.toBeUndefined();

    await inbox.claimSessionHook("alice");
    expect(registry.holder("alice")).toBe("session-alice");
    await expect(registry.deliver("alice", send("first"))).resolves.toEqual({
      kind: "delivered",
      owner: "session-alice",
    });
    await registry.deliver("alice", send("second"));
    // The session kept each before its inbox read it.
    expect(kept).toEqual([
      ["alice", send("first")],
      ["alice", send("second")],
    ]);

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
    await expect(bob.claimSessionHook("shared")).rejects.toThrow(
      'Session address "shared" belongs to another session.',
    );
    await alice.dispose();
    await bob.dispose();
  });


  it("queues what a session kept already, as it kept it, without keeping it again", async () => {
    const registry = createMemoryInboxRegistry(structuredCloneBoundary);
    const kept: unknown[] = [];
    const inbox = createSessionInbox(
      registry.transportFor("session-alice", {
        keep: async (_token, arrival) => {
          kept.push(arrival);
        },
      }),
    );
    await inbox.claimSessionHook("alice");
    const restored = send("restored");
    registry.requeue("alice", restored);
    await expect(inbox.next()).resolves.toBe(restored);
    expect(kept).toEqual([]);
    await inbox.dispose();
  });

  it("keeps what arrives for a run's reserved hook, which reads it once it opens", async () => {
    const registry = createMemoryInboxRegistry(structuredCloneBoundary);
    const journal: unknown[] = [];
    const keep = async (token: string, payload: unknown) => {
      journal.push([token, payload]);
    };
    const release = registry.reserve("run-a", { prefix: "eve:in-process:run-a:" }, { keep });
    await expect(registry.deliver("eve:in-process:run-a:0", { reply: "early" })).resolves.toEqual({
      kind: "delivered",
      owner: "run-a",
    });
    await expect(registry.deliver("eve:in-process:run-b:0", {})).resolves.toBeUndefined();

    const hook = registry.openHook<{ reply: string }>("run-a", "eve:in-process:run-a:0", { keep });
    await expect(hook.claim()).resolves.toBe(true);
    await registry.deliver("eve:in-process:run-a:0", { reply: "later" });
    await registry.replay("eve:in-process:run-a:0", { reply: "replayed" });
    const replies: string[] = [];
    for await (const { reply } of hook) {
      replies.push(reply);
      if (replies.length === 3) break;
    }
    expect(replies).toEqual(["early", "later", "replayed"]);
    // The run's journal holds each arrival once; what it replays it kept before.
    expect(journal).toEqual([
      ["eve:in-process:run-a:0", { reply: "early" }],
      ["eve:in-process:run-a:0", { reply: "later" }],
    ]);
    await hook.dispose();
    release();
    await expect(registry.deliver("eve:in-process:run-a:0", {})).resolves.toEqual({
      kind: "gone",
    });
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
