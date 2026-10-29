import { describe, expect, it } from "vitest";

import { checkCompactedHistory } from "#harness/compaction/authored.js";
import { checkpointHead } from "#harness/compaction/engine.js";
import { createUserMessage, type HarnessModelMessage } from "#harness/messages.js";

const earlier = createUserMessage("user", "Alice asks for the quarterly report.");
const latest = createUserMessage("user", "Bob asks which sources back the second claim.");
const history: HarnessModelMessage[] = [
  earlier,
  { content: "Here is the report.", role: "assistant" },
  latest,
];
const automatic = { automatic: true, limit: 10_000 };

describe("checkCompactedHistory", () => {
  it("accepts a checkpoint followed by the turn's input", () => {
    const compacted = [...checkpointHead("Alice got her report."), latest];
    expect(checkCompactedHistory(history, compacted, automatic)).toEqual(compacted);
  });

  it("rejects an automatic result that keeps an earlier message but not the latest input", () => {
    expect(() =>
      checkCompactedHistory(
        history,
        [...checkpointHead("Bob had a question."), earlier],
        automatic,
      ),
    ).toThrow("removed the turn's input");
  });

  it("lets a manual result drop the latest input, since no model call answers it next", () => {
    const compacted = checkpointHead("Alice and Bob talked.");
    expect(
      checkCompactedHistory(history, compacted, { automatic: false, limit: 10_000 }),
    ).toHaveLength(2);
  });

  it("rejects a checkpoint after other messages", () => {
    expect(() =>
      checkCompactedHistory(history, [latest, ...checkpointHead("Alice got her report.")], {
        automatic: false,
        limit: 10_000,
      }),
    ).toThrow("placed a checkpoint after other messages");
  });
});
