import { describe, expect, it } from "vitest";
import { snapshotRecord, validSnapshot } from "./snapshot.js";
import { aiSdkContentSerializer } from "../adapters/serialization.js";
import type { ScopeRecord } from "./types.js";

const identity = { conversationId: "conversation", runId: "run", turnId: "turn" };
const reference = {
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  traceFlags: 1,
};

function turnRecord(input: {
  capture?: ScopeRecord["capture"];
  attributes?: ScopeRecord["attributes"];
  dataAttributes?: ScopeRecord["attributes"];
}): ScopeRecord {
  return {
    key: "activation:turn",
    identity,
    data: { type: "activation", options: { sequence: 0, attributes: input.dataAttributes ?? {} } },
    reference,
    capture: input.capture ?? { emit: true, recordInputs: true, recordOutputs: true },
    startTimeMs: 0,
    attributes: input.attributes,
  };
}

function turnAttributes(input: { input: string; output?: string }): ScopeRecord["attributes"] {
  const attributes: Record<string, string | boolean> = {
    "agent.trace.content.input": true,
    "agent.trace.content.output": true,
    "gen_ai.input.messages": input.input,
  };
  if (input.output !== undefined) attributes["gen_ai.output.messages"] = input.output;
  return attributes;
}

describe("snapshotRecord's oversized-node fallback", () => {
  // turnContent copies a model's input into both the turn's attributes and its
  // data, which is what pushes the turn node over the budget in production.
  const turnWithContent = (input: {
    capture?: ScopeRecord["capture"];
    input: string;
    output?: string;
  }) => {
    const dataAttributes: Record<string, string> = {
      "gen_ai.input.messages": input.input,
    };
    if (input.output !== undefined) dataAttributes["gen_ai.output.messages"] = input.output;
    return turnRecord({
      capture: input.capture,
      attributes: turnAttributes(input),
      dataAttributes,
    });
  };

  it("keeps the capture-policy attributes truthful and truncates the turn input", () => {
    const input = JSON.stringify([
      { role: "user", parts: [{ content: "x".repeat(60_000), type: "text" }] },
    ]);
    const snapshot = snapshotRecord(turnWithContent({ input }), aiSdkContentSerializer);
    expect(validSnapshot(snapshot)).toBe(true);
    expect(snapshot.attributes?.["agent.trace.content.input"]).toBe(true);
    expect(snapshot.attributes?.["agent.trace.content.output"]).toBe(true);
    const truncated = snapshot.attributes?.["gen_ai.input.messages"];
    expect(typeof truncated).toBe("string");
    expect((truncated as string).length).toBeLessThan(input.length);
    // The marker lives inside the JSON payload.
    expect((truncated as string).includes("… [truncated]")).toBe(true);
    // The truncation stays valid GenAI message JSON.
    const messages = JSON.parse(truncated as string) as unknown[];
    expect(messages).toHaveLength(1);
    expect((messages[0] as { role: string }).role).toBe("user");
  });

  it("truncates the turn output too", () => {
    const output = JSON.stringify([
      {
        finish_reason: "stop",
        parts: [{ content: "y".repeat(60_000), type: "text" }],
        role: "assistant",
      },
    ]);
    const snapshot = snapshotRecord(
      turnWithContent({ input: "[]", output }),
      aiSdkContentSerializer,
    );
    expect(validSnapshot(snapshot)).toBe(true);
    const truncated = snapshot.attributes?.["gen_ai.output.messages"];
    expect(typeof truncated).toBe("string");
    expect((truncated as string).includes("… [truncated]")).toBe(true);
  });

  it("truncates an attribute far over the budget", () => {
    const input = JSON.stringify([
      { role: "user", parts: [{ content: "z".repeat(1_000_000), type: "text" }] },
    ]);
    const snapshot = snapshotRecord(turnWithContent({ input }), aiSdkContentSerializer);
    expect(validSnapshot(snapshot)).toBe(true);
    expect(snapshot.attributes?.["agent.trace.content.input"]).toBe(true);
    const truncated = snapshot.attributes?.["gen_ai.input.messages"];
    expect(typeof truncated).toBe("string");
    expect((truncated as string).length).toBeLessThan(40_000);
    expect((truncated as string).includes("… [truncated]")).toBe(true);
  });

  it("keeps declined capture flagged as false", () => {
    const input = JSON.stringify([
      { role: "user", parts: [{ content: "x".repeat(60_000), type: "text" }] },
    ]);
    const snapshot = snapshotRecord(
      turnWithContent({
        capture: { emit: true, recordInputs: false, recordOutputs: false },
        input,
      }),
      aiSdkContentSerializer,
    );
    expect(snapshot.attributes?.["agent.trace.content.input"]).toBe(false);
    expect(snapshot.attributes?.["agent.trace.content.output"]).toBe(false);
    expect(snapshot.attributes?.["gen_ai.input.messages"]).toBeUndefined();
  });

  it("leaves a node that fits untouched", () => {
    const input = JSON.stringify([{ role: "user", parts: [{ content: "hello", type: "text" }] }]);
    const record = turnWithContent({ input });
    const snapshot = snapshotRecord(record, aiSdkContentSerializer);
    expect(snapshot.attributes?.["agent.trace.content.input"]).toBe(true);
    expect(snapshot.attributes?.["gen_ai.input.messages"]).toBe(input);
  });
});
