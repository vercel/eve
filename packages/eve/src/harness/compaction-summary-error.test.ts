import { describe, expect, it } from "vitest";

import { createCompactionSummaryError } from "#harness/compaction-summary-error.js";

const base = {
  empty: true,
  finishReason: "content-filter",
  rawFinishReason: "refusal",
  providerMetadata: undefined,
  summaryAttempt: 2,
  olderMessageCount: 5,
  recentMessageCount: 2,
};

describe("createCompactionSummaryError", () => {
  it("keeps the existing blank-summary message and records structural diagnostics", () => {
    const error = createCompactionSummaryError({
      ...base,
      providerMetadata: {
        anthropic: { stopDetails: { type: "refusal", category: "policy_code" } },
        gateway: { generationId: "gen_1234" },
      },
    });

    expect(error.message).toBe(
      "The compaction model returned an empty summary. Finish reason: content-filter.",
    );
    expect(error.cause).toEqual({
      finishReason: "content-filter",
      rawFinishReason: "refusal",
      providerStopType: "refusal",
      providerStopCategory: "policy_code",
      generationId: "gen_1234",
      summaryAttempt: 2,
      olderMessageCount: 5,
      recentMessageCount: 2,
    });
  });

  it("does not describe a nonempty refusal as empty", () => {
    const error = createCompactionSummaryError({ ...base, empty: false });
    expect(error.message).toBe(
      "The compaction model declined to summarize the conversation. Finish reason: content-filter.",
    );
  });

  it("does not retain provider explanations, response text, or credentials", () => {
    const secret = "private conversation and API credential";
    const error = createCompactionSummaryError({
      ...base,
      providerMetadata: {
        anthropic: {
          stopDetails: {
            type: "refusal",
            category: "policy_code",
            explanation: secret,
            recommendedModel: secret,
          },
          text: secret,
          apiKey: secret,
        },
        gateway: { generationId: "gen_1234", headers: { authorization: secret } },
        otherProvider: { response: secret },
      },
    });

    expect(JSON.stringify(error.cause)).not.toContain(secret);
    expect(error.cause).not.toHaveProperty("providerMetadata");
  });

  it.each(["", "private note", "code\nprivate", "x".repeat(129), null, 123, {}])(
    "omits non-code metadata (%j)",
    (value) => {
      const error = createCompactionSummaryError({
        ...base,
        providerMetadata: {
          anthropic: { stopDetails: { type: value, category: value } },
          gateway: { generationId: value },
        },
      });
      expect(error.cause).toMatchObject({
        providerStopType: undefined,
        providerStopCategory: undefined,
        generationId: undefined,
      });
    },
  );

  it.each([undefined, {}, { anthropic: [] }, { anthropic: { stopDetails: [] } }])(
    "accepts missing or unsupported provider metadata",
    (providerMetadata) => {
      expect(createCompactionSummaryError({ ...base, providerMetadata }).cause).toMatchObject({
        summaryAttempt: 2,
        providerStopType: undefined,
        providerStopCategory: undefined,
      });
    },
  );

  it("uses a generic code for missing or free-form finish reasons", () => {
    const error = createCompactionSummaryError({
      ...base,
      finishReason: "private model response",
      rawFinishReason: "private model response",
    });
    expect(error.message).toContain("Finish reason: unknown.");
    expect(JSON.stringify(error.cause)).not.toContain("private");
  });
});
