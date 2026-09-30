import { afterEach, describe, expect, it } from "vitest";
import {
  CONSOLE_RECORD_PREFIX,
  createConsoleOutputForwarder,
  parseConsoleRecord,
  setConsoleRecordSubscriber,
} from "./console-records.js";

afterEach(() => setConsoleRecordSubscriber(undefined));

describe("dev console transport", () => {
  it("preserves multiline warnings across chunk boundaries without classifying raw stderr", () => {
    const records: unknown[] = [];
    const raw: string[] = [];
    setConsoleRecordSubscriber((record) => records.push(record));
    const forwarder = createConsoleOutputForwarder((text) => raw.push(text));
    const encoded = `${CONSOLE_RECORD_PREFIX}${JSON.stringify({ level: "warn", text: "Step already running\n  run abc\n  step def" })}\n`;
    forwarder.write(encoded.slice(0, 15));
    forwarder.write(encoded.slice(15) + "raw failure\npartial");
    forwarder.flush();
    expect(records).toEqual([
      { level: "warn", text: "Step already running\n  run abc\n  step def" },
    ]);
    expect(raw).toEqual(["raw failure\n", "partial"]);
  });
  it("leaves malformed frames as unclassified output", () => {
    expect(parseConsoleRecord(`${CONSOLE_RECORD_PREFIX}null`)).toBeUndefined();
    expect(
      parseConsoleRecord(`${CONSOLE_RECORD_PREFIX}{"level":"fatal","text":"oops"}`),
    ).toBeUndefined();
    expect(parseConsoleRecord("ordinary stderr")).toBeUndefined();
  });
});
