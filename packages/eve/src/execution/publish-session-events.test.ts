import { expect, it, vi } from "vitest";
import { ContextContainer } from "#context/container.js";
import {
  commitSessionStep,
  openSessionEventPublisher,
  openSessionEventWriter,
} from "#execution/publish-session-events.js";
import { enterSessionProjection } from "#harness/session-machine/current.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { createTurnCompletedEvent, createTurnStartedEvent } from "#protocol/message.js";
import { createRuntimeHookRegistry } from "#runtime/hooks/registry.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

const turnStarted = (sequence: number) =>
  createTurnStartedEvent({ sequence, turnId: `turn-${String(sequence)}` });

function gatedPublisher() {
  let finishWrite!: () => void;
  let startedWrite!: () => void;
  const writeSettled = new Promise<void>((resolve) => {
    finishWrite = resolve;
  });
  const writeStarted = new Promise<void>((resolve) => {
    startedWrite = resolve;
  });
  const ctx = new ContextContainer();
  ctx.set(ChannelKey, { kind: "test" } as never);
  ctx.set(BundleKey, { hookRegistry: createRuntimeHookRegistry([]) } as never);
  enterSessionProjection(ctx, createTestSessionState().snapshot.session.state);
  const publisher = openSessionEventPublisher({
    ctx,
    origin: "own",
    sessionWritable: new WritableStream<Uint8Array>({
      write() {
        startedWrite();
        return writeSettled;
      },
    }),
  });
  return { finishWrite, publisher, writeStarted };
}

const target = () => ({
  serializedContext: {},
  sessionState: createTestSessionState(),
  sessionWritable: new WritableStream<Uint8Array>(),
});
it("rejects overlapping turn snapshots before restoring or publishing", async () => {
  await expect(
    commitSessionStep(
      target(),
      (view) => [
        { turn: { ...view.turn }, events: [] },
        { turn: { ...view.turn }, events: [] },
      ],
      { origin: "relayed" },
    ),
  ).rejects.toThrow("must not overlap");
});
it("rejects overlapping sign-in snapshots before restoring or publishing", async () => {
  await expect(
    commitSessionStep(
      target(),
      (view) => [
        { turn: view.turn, events: [], signIns: [] },
        { turn: view.turn, events: [], signIns: [] },
      ],
      { origin: "relayed" },
    ),
  ).rejects.toThrow("must not overlap");
});
it("allows a batch of unchanged transitions", async () => {
  const state = target();
  await expect(
    commitSessionStep(
      state,
      (view) => [
        { turn: view.turn, events: [] },
        { turn: view.turn, events: [] },
      ],
      { origin: "relayed" },
    ),
  ).resolves.toEqual({
    serializedContext: state.serializedContext,
    sessionState: state.sessionState,
  });
});

it("rejects a changed turn followed by the original turn snapshot", async () => {
  await expect(
    commitSessionStep(
      target(),
      (view) => [
        { turn: { ...view.turn }, events: [] },
        { turn: view.turn, events: [] },
      ],
      { origin: "relayed" },
    ),
  ).rejects.toThrow("must not overlap");
});

it("does not wait for a pre-model event's write", async () => {
  const { finishWrite, publisher, writeStarted } = gatedPublisher();
  let emitted = false;
  const emit = publisher.emit(turnStarted(0)).then(() => {
    emitted = true;
  });

  await writeStarted;
  await vi.waitFor(() => expect(emitted).toBe(true));

  finishWrite();
  await emit;
  await publisher.writer.release();
});

it("waits for a boundary event's write before returning", async () => {
  const { finishWrite, publisher, writeStarted } = gatedPublisher();
  let emitted = false;
  const emit = publisher
    .emit(createTurnCompletedEvent({ sequence: 1, turnId: "turn-1" }))
    .then(() => {
      emitted = true;
    });

  await writeStarted;
  await Promise.resolve();
  expect(emitted).toBe(false);

  finishWrite();
  await emit;
  await publisher.writer.release();
});

it("returns from a write before the stream settles and drains the queue", async () => {
  let finishWrite!: () => void;
  const writeSettled = new Promise<void>((resolve) => {
    finishWrite = resolve;
  });
  const writer = openSessionEventWriter({
    deliveryIds: () => undefined,
    sessionWritable: new WritableStream<Uint8Array>({
      write: () => writeSettled,
    }),
  });

  await writer.write(turnStarted(0));

  let drained = false;
  const drain = writer.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);

  finishWrite();
  await drain;
  await writer.release();
});

it("writes queued events in order", async () => {
  const sequences: number[] = [];
  const writer = openSessionEventWriter({
    deliveryIds: () => undefined,
    sessionWritable: new WritableStream<Uint8Array>({
      write(chunk) {
        const event = JSON.parse(new TextDecoder().decode(chunk).trim()) as {
          data: { sequence: number };
        };
        sequences.push(event.data.sequence);
      },
    }),
  });

  await writer.write(turnStarted(0));
  await writer.write(turnStarted(1));
  await writer.write(turnStarted(2));
  await writer.drain();

  expect(sequences).toEqual([0, 1, 2]);
  await writer.release();
});

it("surfaces a stream failure on drain and on later writes", async () => {
  const writer = openSessionEventWriter({
    deliveryIds: () => undefined,
    sessionWritable: new WritableStream<Uint8Array>({
      write() {
        throw new Error("stream failed");
      },
    }),
  });

  await writer.write(turnStarted(0));
  await expect(writer.drain()).rejects.toThrow("stream failed");
  await expect(writer.write(turnStarted(1))).rejects.toThrow("stream failed");
  await writer.release();
});

it("waits for queued writes before releasing the stream", async () => {
  let finishWrite!: () => void;
  const writeSettled = new Promise<void>((resolve) => {
    finishWrite = resolve;
  });
  const writer = openSessionEventWriter({
    deliveryIds: () => undefined,
    sessionWritable: new WritableStream<Uint8Array>({
      write: () => writeSettled,
    }),
  });

  await writer.write(turnStarted(0));
  let released = false;
  const release = writer.release().then(() => {
    released = true;
  });
  await Promise.resolve();
  expect(released).toBe(false);

  finishWrite();
  await release;
  expect(released).toBe(true);
});
