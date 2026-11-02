import { describe, expect, it } from "vitest";

import { fitTranscript, type TranscriptTurn } from "./transcript.js";

const call = (index: number) =>
  `<call>${JSON.stringify({ name: "inspect", step: index, output: "x".repeat(90) })}</call>`;

const done: TranscriptTurn = {
  opener: '<turn status="completed">',
  task: '<user>"Say hi."</user>',
  entries: ['<agent phase="reply">"Hi."</agent>'],
};

describe("fitTranscript", () => {
  it("keeps every turn when they fit", () => {
    const running: TranscriptTurn = {
      opener: '<turn status="running">',
      task: '<user>"Audit billing."</user>',
      entries: [call(1)],
    };
    expect(fitTranscript([done, running], 10_000).split("\n")).toEqual([
      done.opener,
      done.task,
      ...done.entries,
      "</turn>",
      running.opener,
      running.task,
      call(1),
      "</turn>",
    ]);
  });

  it("keeps the running turn's opener and task when the turn alone is over budget", () => {
    const running: TranscriptTurn = {
      opener: '<turn status="running">',
      task: '<user>"Audit billing."</user>',
      entries: Array.from({ length: 20 }, (_, index) => call(index + 1)),
    };
    const lines = fitTranscript([done, running], 600).split("\n");

    expect(lines.join("\n").length).toBeLessThanOrEqual(600);
    expect(lines[0]).toBe('<omitted_earlier turns="1"/>');
    expect(lines.slice(1, 3)).toEqual([running.opener, running.task]);
    expect(lines[3]).toMatch(/^<omitted_earlier_in_turn entries="\d+"\/>$/);
    // The newest calls survive, in order, and the turn closes.
    expect(lines.at(-2)).toBe(call(20));
    expect(lines.at(-1)).toBe("</turn>");
  });

  it("drops whole earlier turns from the oldest end", () => {
    const turns = Array.from({ length: 5 }, (_, index): TranscriptTurn => ({
      ...done,
      task: `<user>"Turn ${index}."</user>`,
    }));
    const lines = fitTranscript(turns, 250).split("\n");

    expect(lines[0]).toMatch(/^<omitted_earlier turns="\d+"\/>$/);
    // Every kept turn is complete: openers and closers pair up.
    expect(lines.filter((line) => line.startsWith("<turn ")).length).toBe(
      lines.filter((line) => line === "</turn>").length,
    );
    expect(lines.at(-3)).toBe('<user>"Turn 4."</user>');
  });
});
