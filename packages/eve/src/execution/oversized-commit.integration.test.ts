import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { SandboxKey } from "#context/keys.js";
import { openSessionEventPublisher } from "#execution/publish-session-events.js";
import { enterSessionProjection } from "#harness/session-machine/current.js";
import { decodeSandboxRef } from "#internal/attachments/sandbox-refs.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { MAX_SESSION_LINE_BYTES } from "#protocol/session-events/envelope.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

/** A tool result no stored line could hold inline. */
const OVERSIZED_OUTPUT = { image: "x".repeat(MAX_SESSION_LINE_BYTES) };

interface Written {
  readonly lines: Record<string, unknown>[];
  readonly writable: WritableStream<Uint8Array>;
}

/** Collects the NDJSON lines a publication writes. */
function capture(): Written {
  const lines: Record<string, unknown>[] = [];
  const decoder = new TextDecoder();
  return {
    lines,
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        for (const line of decoder.decode(chunk).split("\n")) {
          if (line.trim().length > 0) lines.push(JSON.parse(line));
        }
      },
    }),
  };
}

function publisherFor(written: Written, sandbox?: ReturnType<typeof mockSandbox>) {
  const ctx = new ContextContainer();
  ctx.set(ChannelKey, { kind: "http", state: {} } as never);
  if (sandbox !== undefined) ctx.set(SandboxKey, sandbox.access);
  enterSessionProjection(ctx, undefined);
  return openSessionEventPublisher({
    ctx,
    origin: "own",
    sessionWritable: written.writable,
  });
}

/** The facts of one turn whose only call returns an oversized result. */
function turnFacts(output: unknown): SessionEvent[] {
  return [
    { type: "session.started", data: {} },
    { type: "turn.started", data: { turnId: "t1", cause: { turnId: "t1" }, follows: null } },
    { type: "model.requested", data: { runId: "r1", owner: { turnId: "t1" } } },
    {
      type: "call.requested",
      data: {
        callId: "c1",
        capability: { kind: "tool", name: "render" },
        input: { chart: "sales" },
        owner: { runId: "r1" },
      },
    },
    { type: "call.settled", data: { callId: "c1", outcome: "completed", output } },
  ] as SessionEvent[];
}

/** The facts of a turn whose call is running, so a progress record for it is well-formed. */
function runningCallFacts(): SessionEvent[] {
  return [
    ...turnFacts(undefined).slice(0, -1),
    { type: "call.started", data: { callId: "c1" } },
  ] as SessionEvent[];
}

/** The data of the one fact of `type` the publication wrote. */
function dataOf(written: Written, type: string): Record<string, unknown> {
  const facts = written.lines.flatMap(factsOf).filter((fact) => fact.type === type);
  expect(facts).toHaveLength(1);
  const [fact] = facts;
  if (fact === undefined) throw new Error(`no ${type} fact was written`);
  return fact.data as Record<string, unknown>;
}

function factsOf(line: Record<string, unknown>): Record<string, unknown>[] {
  return (line.facts ?? []) as Record<string, unknown>[];
}

describe("committing a turn whose call returned an oversized result", () => {
  it("publishes the result by reference instead of refusing the commit", async () => {
    const written = capture();
    const sandbox = mockSandbox();
    const publisher = publisherFor(written, sandbox);

    await publisher.emit(turnFacts(OVERSIZED_OUTPUT));

    const data = dataOf(written, "call.settled");
    expect(data.output).toBeUndefined();

    const reference = data.outputRef as Record<string, unknown>;
    expect(reference.mediaType).toBe("application/json");
    expect(reference.size).toBe(JSON.stringify(OVERSIZED_OUTPUT).length);
    // A preview so a reader still shows something without fetching the value.
    expect(reference.preview).toContain("image");
    expect(sandbox.files.get(decodeSandboxRef(reference.ref as string).path)).toBe(
      JSON.stringify(OVERSIZED_OUTPUT),
    );

    // The facts beside it committed too, and their small values stayed inline: the whole point
    // is that one large value no longer costs the turn.
    expect(dataOf(written, "call.requested").input).toEqual({ chart: "sales" });
  });

  it("commits with the result withheld when there is no sandbox to store it in", async () => {
    const written = capture();
    const publisher = publisherFor(written);

    await publisher.emit(turnFacts(OVERSIZED_OUTPUT));

    expect(dataOf(written, "call.settled").outputRef).toEqual({
      mediaType: "application/json",
      withheld: true,
      size: JSON.stringify(OVERSIZED_OUTPUT).length,
      preview: expect.stringContaining("image"),
    });
  });

  it("drops an oversized progress record and keeps committing", async () => {
    // A progress record is a preview a later fact completes, and the envelope says any of them
    // may be missing, so dropping one is cheaper than failing the publication around it.
    const written = capture();
    const sandbox = mockSandbox();
    const publisher = publisherFor(written, sandbox);

    await publisher.emit([
      ...runningCallFacts(),
      {
        type: "call.progress",
        data: { callId: "c1", output: { partial: "y".repeat(MAX_SESSION_LINE_BYTES) } },
      },
    ] as SessionEvent[]);

    expect(written.lines.some((line) => "progress" in line)).toBe(false);
    expect(written.lines.flatMap(factsOf).map((fact) => fact.type)).toContain("call.started");
    // Nothing was stored for it: a dropped preview is not worth a round trip.
    expect(sandbox.writes).toHaveLength(0);
  });

  it("keeps a progress record that fits", async () => {
    const written = capture();
    const publisher = publisherFor(written);

    await publisher.emit([
      ...runningCallFacts(),
      { type: "call.progress", data: { callId: "c1", output: { partial: "y" } } },
    ] as SessionEvent[]);

    expect(written.lines.filter((line) => "progress" in line)).toHaveLength(1);
  });

  it("still refuses a commit whose bulk is in a field with no reference slot", async () => {
    // The honest outcome once there is nothing left to move: the commit is
    // refused as it was before, and the error says why.
    const written = capture();
    const sandbox = mockSandbox();
    const publisher = publisherFor(written, sandbox);

    await expect(
      publisher.emit([
        ...turnFacts(undefined),
        {
          type: "content.completed",
          data: {
            partId: "p1",
            runId: "r1",
            kind: "text",
            phase: "reply",
            value: "ok",
            fallbackText: "z".repeat(MAX_SESSION_LINE_BYTES),
          },
        },
      ] as SessionEvent[]),
    ).rejects.toThrow(/no reference slot/);
    expect(written.lines).toHaveLength(0);
  });

  it("leaves a commit that already fits byte for byte", async () => {
    const withSandbox = capture();
    const sandbox = mockSandbox();
    await publisherFor(withSandbox, sandbox).emit(turnFacts({ image: "small" }));

    expect(dataOf(withSandbox, "call.settled").output).toEqual({ image: "small" });
    expect(sandbox.writes).toHaveLength(0);
  });
});
