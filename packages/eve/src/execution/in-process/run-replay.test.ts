import { describe, expect, it } from "vitest";

import { runMessagesIn } from "#execution/tools/workflow/messages.js";
import { RunReplay } from "./run-replay.js";

const ref = {
  callId: "call-1",
  input: {},
  runId: "run-a",
  sequence: 1,
  stepIndex: 0,
  toolName: "reviewer",
  turnId: "turn-1",
};
const started = { from: ref, kind: "started" } as const;

describe("runMessagesIn", () => {
  it("reads a lone message, a batch's, and nothing from anything else", () => {
    expect(runMessagesIn(started)).toEqual([started]);
    expect(runMessagesIn({ kind: "workflow-batch", messages: [started, started] })).toHaveLength(2);
    expect(runMessagesIn({ kind: "send" })).toEqual([]);
    expect(runMessagesIn(undefined)).toEqual([]);
  });
});

describe("RunReplay", () => {
  it("replays what a hook received once the run is as far as it was, and skips what was heard", async () => {
    const delivered: unknown[] = [];
    const replay = new RunReplay(
      {
        heard: 1,
        received: [
          { afterSent: 0, payload: "call", token: "control" },
          { afterSent: 1, payload: "reply", token: "eve:in-process:run-a:0" },
        ],
      },
      async (token, payload) => {
        delivered.push([token, payload]);
      },
    );
    await replay.opened("control");
    expect(delivered).toEqual([["control", "call"]]);
    // Its session heard the first message before the restore, so the run doesn't send it again.
    expect(replay.send(started)).toBe(false);
    await replay.opened("eve:in-process:run-a:0");
    expect(delivered).toEqual([
      ["control", "call"],
      ["eve:in-process:run-a:0", "reply"],
    ]);
    expect(replay.send(started)).toBe(true);
    expect(replay.sent).toBe(2);
  });
});
