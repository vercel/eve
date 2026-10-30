import { describe, expect, it, vi } from "vitest";

import type { CommitLine, ProgressLine, ValueReference } from "./envelope.js";
import { encodeLineBytes, MAX_SESSION_LINE_BYTES } from "./envelope.js";
import { prepareLine, previewOf } from "./large-values.js";

type Fact = { readonly type: string; readonly data: Record<string, unknown> };

/** A value whose JSON is `bytes` long, give or take the quotes around it. */
function valueOf(bytes: number): string {
  return "x".repeat(bytes);
}

/** The data of the fact at `index`, which every fixture here has. */
function factData(line: CommitLine<Fact>, index: number): Record<string, unknown> {
  const fact = line.facts[index];
  if (fact === undefined) throw new Error(`no fact at ${index}`);
  return fact.data;
}

function commit(facts: readonly Fact[]): CommitLine<Fact> {
  return { at: "2026-01-01T00:00:00.000Z", facts };
}

/** A store that records what it was asked to keep and hands back a ref for each. */
function recordingStore() {
  const staged: unknown[] = [];
  const stage = vi.fn(async (value: unknown): Promise<ValueReference> => {
    staged.push(value);
    return { mediaType: "application/json", ref: `eve-sandbox:?n=${staged.length}` };
  });
  return { staged, stage };
}

describe("prepareLine", () => {
  it("leaves a line that already fits untouched", async () => {
    const { stage } = recordingStore();
    const line = commit([
      { type: "call.settled", data: { callId: "c1", outcome: "completed", output: "small" } },
    ]);

    const prepared = await prepareLine(line, stage);
    expect(prepared.line).toBe(line);
    expect(prepared.oversized).toBe(false);
    // The encode the caller needed anyway is the only cost on this path.
    expect(prepared.bytes).toEqual(encodeLineBytes(line));
    expect(stage).not.toHaveBeenCalled();
  });

  it("moves an oversized output to the store and carries a reference", async () => {
    const { staged, stage } = recordingStore();
    const output = valueOf(MAX_SESSION_LINE_BYTES);
    const line = commit([
      { type: "call.settled", data: { callId: "c1", outcome: "completed", output } },
    ]);

    const { bytes, line: rewritten, oversized } = await prepareLine(line, stage);

    expect(oversized).toBe(false);
    expect(staged).toEqual([output]);
    expect(factData(rewritten, 0)).toEqual({
      callId: "c1",
      outcome: "completed",
      outputRef: {
        mediaType: "application/json",
        ref: "eve-sandbox:?n=1",
        size: output.length + 2,
        preview: previewOf(output),
      },
    });
    // The whole point: the rewritten line is writable, and its bytes come back ready.
    expect(bytes).toEqual(encodeLineBytes(rewritten));
  });

  it("moves the largest value first, and stops once the line fits", async () => {
    // One oversized value is the whole problem; a small one beside it must not pay for a round
    // trip to the store that would not have helped.
    const { staged, stage } = recordingStore();
    const line = commit([
      { type: "call.requested", data: { callId: "c1", input: valueOf(1024) } },
      {
        type: "call.settled",
        data: { callId: "c1", outcome: "completed", output: valueOf(MAX_SESSION_LINE_BYTES) },
      },
    ]);

    const { line: rewritten } = await prepareLine(line, stage);

    expect(stage).toHaveBeenCalledOnce();
    expect(staged[0]).toHaveLength(MAX_SESSION_LINE_BYTES);
    expect(factData(rewritten, 0)).toHaveProperty("input");
    expect(factData(rewritten, 0)).not.toHaveProperty("inputRef");
    expect(factData(rewritten, 1)).toHaveProperty("outputRef");
  });

  it("keeps moving values while the line is still too large", async () => {
    // Three values, each 60% of the limit: moving one still leaves the line over it, so the
    // second has to move too — and the third must not, because by then the line fits.
    const { stage } = recordingStore();
    const part = valueOf(Math.ceil(MAX_SESSION_LINE_BYTES * 0.6));
    const line = commit([
      { type: "call.requested", data: { callId: "c1", input: part } },
      { type: "call.settled", data: { callId: "c1", outcome: "completed", output: part } },
      {
        type: "content.completed",
        data: { partId: "p1", runId: "r1", kind: "result", phase: "reply", value: part },
      },
    ]);

    const { line: rewritten } = await prepareLine(line, stage);

    expect(stage).toHaveBeenCalledTimes(2);
    expect(
      rewritten.facts.filter(
        (fact) => "input" in fact.data || "output" in fact.data || "value" in fact.data,
      ),
    ).toHaveLength(1);
    expect(() => encodeLineBytes(rewritten)).not.toThrow();
  });

  it("references a completed content part's value", async () => {
    const { stage } = recordingStore();
    const line = commit([
      {
        type: "content.completed",
        data: {
          partId: "p1",
          runId: "r1",
          kind: "result",
          phase: "reply",
          value: valueOf(MAX_SESSION_LINE_BYTES),
        },
      },
    ]);

    const { line: rewritten } = await prepareLine(line, stage);

    expect(factData(rewritten, 0)).not.toHaveProperty("value");
    expect(factData(rewritten, 0)).toHaveProperty("valueRef");
  });

  it("leaves a value its writer already referenced alone", async () => {
    const { stage } = recordingStore();
    const line = commit([
      {
        type: "call.settled",
        data: {
          callId: "c1",
          outcome: "completed",
          outputRef: { mediaType: "application/json", withheld: true },
          // Bulk the envelope has no reference slot for.
          label: valueOf(MAX_SESSION_LINE_BYTES),
        },
      },
    ]);

    const { line: rewritten, oversized } = await prepareLine(line, stage);

    expect(stage).not.toHaveBeenCalled();
    // Nothing left to move, so the line is returned as it stands and the caller's encode
    // refuses it — the honest outcome, not a silent truncation.
    expect(oversized).toBe(true);
    expect(() => encodeLineBytes(rewritten)).toThrow(/Session commit is/);
  });

  it("has nothing to move in a fact type with no reference slot", async () => {
    const { stage } = recordingStore();
    const line = commit([
      { type: "call.progress", data: { callId: "c1", output: valueOf(MAX_SESSION_LINE_BYTES) } },
    ]);

    const prepared = await prepareLine(line, stage);
    expect(prepared.line).toBe(line);
    expect(prepared.oversized).toBe(true);
    expect(stage).not.toHaveBeenCalled();
  });

  it("has nothing to move in a progress record", async () => {
    // Progress records are previews a later fact completes, and the envelope says any of them may
    // be missing, so the publisher drops an oversized one rather than referencing it.
    const { stage } = recordingStore();
    const line: ProgressLine<Fact> = {
      progress: {
        type: "call.progress",
        data: { callId: "c1", output: valueOf(MAX_SESSION_LINE_BYTES) },
      },
    };

    const prepared = await prepareLine(line, stage);
    expect(prepared.line).toBe(line);
    expect(prepared.oversized).toBe(true);
    expect(stage).not.toHaveBeenCalled();
  });
});

describe("previewOf", () => {
  it("keeps a short value whole", () => {
    expect(previewOf({ ok: true })).toBe('{"ok":true}');
  });

  it("truncates a long one so a reader still sees something", () => {
    const preview = previewOf(valueOf(10_000));
    expect(preview).toHaveLength(257);
    expect(preview.endsWith("…")).toBe(true);
  });
});
