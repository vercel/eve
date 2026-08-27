import { describe, expect, it } from "vitest";

import { withoutDeclinedContent } from "#tracing/content-attributes.js";

const ATTRIBUTES = {
  "agent.channel.delivery.input": '{"message":"private"}',
  "ai.prompt.messages": "what the user said",
  "ai.response.finish_reason": "stop",
  "ai.response.text": "what the model said",
  "gen_ai.request.model": "test-model",
  "gen_ai.tool.call.arguments": "{}",
  "gen_ai.tool.call.result": "42",
  "gen_ai.tool.name": "weather",
};

describe("withoutDeclinedContent", () => {
  it("keeps everything when the destination declined nothing", () => {
    expect(
      withoutDeclinedContent(ATTRIBUTES, { recordInputs: true, recordOutputs: true }),
    ).toBeUndefined();
  });

  it("keeps everything when the span carries none of what was declined", () => {
    expect(
      withoutDeclinedContent(
        { "gen_ai.request.model": "test-model" },
        { recordInputs: false, recordOutputs: false },
      ),
    ).toBeUndefined();
  });

  it("drops inputs alone", () => {
    expect(
      withoutDeclinedContent(ATTRIBUTES, { recordInputs: false, recordOutputs: true }),
    ).toEqual({
      "ai.response.finish_reason": "stop",
      "ai.response.text": "what the model said",
      "gen_ai.request.model": "test-model",
      "gen_ai.tool.call.result": "42",
      "gen_ai.tool.name": "weather",
    });
  });

  it("drops outputs alone", () => {
    expect(
      withoutDeclinedContent(ATTRIBUTES, { recordInputs: true, recordOutputs: false }),
    ).toEqual({
      "agent.channel.delivery.input": '{"message":"private"}',
      "ai.prompt.messages": "what the user said",
      "ai.response.finish_reason": "stop",
      "gen_ai.request.model": "test-model",
      "gen_ai.tool.call.arguments": "{}",
      "gen_ai.tool.name": "weather",
    });
  });

  // The prefixes are shared: `ai.response.finish_reason` and `gen_ai.tool.name`
  // say what happened rather than what was said, so declining content cannot
  // cost a destination the ability to read its own traces.
  it("keeps metadata that shares a prefix with content", () => {
    expect(
      withoutDeclinedContent(ATTRIBUTES, { recordInputs: false, recordOutputs: false }),
    ).toEqual({
      "ai.response.finish_reason": "stop",
      "gen_ai.request.model": "test-model",
      "gen_ai.tool.name": "weather",
    });
  });

  it("leaves the attributes it was handed alone", () => {
    const attributes = { ...ATTRIBUTES };
    withoutDeclinedContent(attributes, { recordInputs: false, recordOutputs: false });
    expect(attributes).toEqual(ATTRIBUTES);
  });
});
