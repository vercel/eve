import { describe, expect, it } from "vitest";
import { snapshotRecord, validSnapshot } from "./snapshot.js";
import { aiSdkContentSerializer, genAiInputMessagesAttribute } from "../adapters/serialization.js";
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

  it("keeps a turn that fits the raised budgets untouched", () => {
    const input = JSON.stringify([
      { role: "user", parts: [{ content: "x".repeat(60_000), type: "text" }] },
    ]);
    const snapshot = snapshotRecord(turnWithContent({ input }), aiSdkContentSerializer);
    expect(validSnapshot(snapshot)).toBe(true);
    expect(snapshot.attributes?.["agent.trace.content.input"]).toBe(true);
    expect(snapshot.attributes?.["agent.trace.content.output"]).toBe(true);
    expect(snapshot.attributes?.["gen_ai.input.messages"]).toBe(input);
  });

  it("keeps a turn input capped by the content serializer", () => {
    // Production copies the model scope's prepared attribute, which the
    // serializer already capped at CONTENT_ATTRIBUTE_LIMIT.
    const messages = [{ role: "user", content: "x".repeat(400_000) }];
    const capped = genAiInputMessagesAttribute(messages)!.json;
    expect(capped.length).toBeLessThanOrEqual(250 * 1024);
    const snapshot = snapshotRecord(turnWithContent({ input: capped }), aiSdkContentSerializer);
    expect(validSnapshot(snapshot)).toBe(true);
    expect(snapshot.attributes?.["agent.trace.content.input"]).toBe(true);
    const kept = snapshot.attributes?.["gen_ai.input.messages"];
    expect(kept).toBe(capped);
    expect((kept as string).includes("… [truncated]")).toBe(true);
    expect(JSON.parse(kept as string)).toHaveLength(1);
  });

  it("shrinks an oversized checkpoint copy instead of denying capture", () => {
    // A host can supply an attribute larger than the serializer would produce;
    // the checkpoint then exceeds the node budget and the copy is fitted.
    const input = JSON.stringify([
      { role: "user", parts: [{ content: "x".repeat(600_000), type: "text" }] },
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
});
