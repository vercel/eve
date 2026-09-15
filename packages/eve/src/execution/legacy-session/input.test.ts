import { describe, expect, it } from "vitest";
import { readLegacyTurnInput } from "./input.js";
const step = {
  parentWritable: {},
  sessionState: { sessionId: "old" },
  serializedContext: {},
  input: { kind: "deliver", payloads: [{ message: "Alice asks to continue." }] },
};
describe("legacy turn input", () => {
  it.each([undefined, 1, 2])("imports version %s", (version) => {
    const input =
      version === undefined ? { ...step, delivery: step.input } : { version, stepInput: step };
    expect(
      readLegacyTurnInput({ ...input, completionToken: "old:turn:0", mode: "conversation" })
        .delivery,
    ).toEqual(step.input);
  });
  it("adopts a committed inline step without appending its input again", () => {
    const committed = {
      sessionState: { sessionId: "old", snapshot: "committed" },
      serializedContext: { committed: true },
    };
    const input = readLegacyTurnInput({
      version: 2,
      stepInput: step,
      completionToken: "old:turn:0",
      mode: "conversation",
      initialStep: { beforeStep: step, result: committed },
    });
    expect(input.sessionState).toEqual(committed.sessionState);
    expect(input.serializedContext).toEqual(committed.serializedContext);
    expect(input.delivery).toBeUndefined();
  });
  it("uses the final committed checkpoint instead of the earlier background-task checkpoint", () => {
    const finalState = { sessionId: "old", snapshot: "final" };
    const input = readLegacyTurnInput({
      version: 2,
      stepInput: step,
      completionToken: "old:turn:0",
      mode: "conversation",
      initialStep: {
        result: {
          action: "park",
          sessionState: finalState,
          serializedContext: { final: true },
          backgroundTaskState: { sessionId: "old", snapshot: "before" },
        },
      },
    });
    expect(input.sessionState).toEqual(finalState);
    expect(input.delivery).toBeUndefined();
  });
  it("rejects unknown formats before publishing an owner", () => {
    expect(() => readLegacyTurnInput({ version: 3 })).toThrow("Unsupported");
    expect(() => readLegacyTurnInput({ version: 2 })).toThrow("Invalid");
  });
});
