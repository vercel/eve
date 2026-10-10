import { expect, it } from "vitest";
import { commitSessionStep } from "#execution/publish-session-events.js";
import { createTestSessionState } from "#internal/testing/session-state.js";

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
