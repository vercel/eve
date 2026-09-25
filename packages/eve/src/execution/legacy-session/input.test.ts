import { describe, expect, it } from "vitest";
import { readLegacyTurnInput } from "./input.js";
const step = {
  parentWritable: {},
  sessionState: { sessionId: "old" },
  serializedContext: {},
  input: { kind: "deliver", payloads: [{ message: "Alice asks to continue." }] },
};
describe("legacy turn input", () => {
  it.each([1, 2])("imports version %s", (version) => {
    expect(
      readLegacyTurnInput({
        version,
        stepInput: step,
        completionToken: "old:turn:0",
      }).delivery,
    ).toEqual(step.input);
  });
  it("rejects an unversioned driver input", () => {
    expect(() =>
      readLegacyTurnInput({
        ...step,
        delivery: step.input,
        completionToken: "old:turn:0",
      }),
    ).toThrow("Unsupported legacy turn input version.");
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
      initialStep: { beforeStep: step, result: committed },
    });
    expect(input.sessionState).toEqual(committed.sessionState);
    expect(input.serializedContext).toEqual(committed.serializedContext);
    expect(input.delivery).toBeUndefined();
  });
  it("rejects unknown formats before publishing an owner", () => {
    expect(() => readLegacyTurnInput({ version: 3 })).toThrow("Unsupported");
    expect(() => readLegacyTurnInput({ version: 2 })).toThrow("Invalid");
  });
});
