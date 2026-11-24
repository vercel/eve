import { Experimental_ExtractionMockModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { extract } from "#public/ai/index.js";

const localExtractionModel = vi.hoisted(() => vi.fn());
vi.mock("#internal/model-auth/transport.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#internal/model-auth/transport.js")>()),
  localGatewayExtractionModel: localExtractionModel,
}));

const fields = {
  invoiceNumber: { type: "text", instructions: "The invoice number" },
  total: { type: "number", unit: "USD", instructions: "The total amount due" },
  contacts: { type: "list", items: "text", instructions: "Contact names" },
  dueDate: { type: "date", instructions: "The payment due date" },
} as const;
const state = "Invoice INV-2041 from Acme Corp for $1,250. Contacts: Ana, Bo.";

function extractionModel() {
  const doExtract = vi.fn(async () => ({
    answers: {
      invoiceNumber: {
        type: "text" as const,
        value: "INV-2041",
        confidence: 0.98,
        source: { type: "text" as const, part: 0, start: 8, end: 16 },
      },
      total: { type: "number" as const, value: 1250, confidence: 0.9 },
      contacts: {
        type: "list" as const,
        value: ["Ana", "Bo"],
        items: [{ confidence: 0.95 }, { confidence: 0.6 }],
      },
      dueDate: { type: "date" as const, value: "", pNull: 0.9 },
    },
    usage: { inputTokens: 30, outputTokens: 4 },
    warnings: [],
  }));
  return { doExtract, model: new Experimental_ExtractionMockModelV4({ doExtract }) };
}

beforeEach(() => {
  localExtractionModel.mockReset();
  vi.stubGlobal("AI_SDK_DEFAULT_PROVIDER", undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe("extract", () => {
  it("resolves a model ID through the local Gateway connection without a session context", async () => {
    const extractor = extractionModel();
    localExtractionModel.mockReturnValue(extractor.model);

    const result = await extract({ model: "scaledown/extract-1", state, fields });

    expect(localExtractionModel).toHaveBeenCalledWith("scaledown/extract-1");
    expect(result.answers.invoiceNumber).toMatchObject({
      value: "INV-2041",
      confidence: 0.98,
      source: { type: "text", part: 0, start: 8, end: 16 },
    });
    expect(result.answers.contacts.value).toEqual(["Ana", "Bo"]);
    expect(result.answers.contacts.items?.[1]?.confidence).toBe(0.6);
    expect(result.answers.dueDate).toEqual({ type: "date", value: null, pNull: 0.9 });
    expectTypeOf(result.answers.invoiceNumber.value).toEqualTypeOf<string | null>();
    expectTypeOf(result.answers.total.value).toEqualTypeOf<number | null>();
    expectTypeOf(result.answers.contacts.value).toEqualTypeOf<string[] | null>();
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 4, totalTokens: 34 });
    expect(Object.keys(result).sort()).toEqual(["answers", "usage"]);
    expectTypeOf<Parameters<typeof extract>[0]>().not.toHaveProperty("telemetry");
  });

  it("requires a model instead of choosing a default", async () => {
    await expect(
      // @ts-expect-error eve has no default extraction model.
      extract({ state, fields }),
    ).rejects.toThrow('extract requires a model, such as "scaledown/extract-1"');
    expect(localExtractionModel).not.toHaveBeenCalled();
  });

  it("preserves the configured default provider for model IDs", async () => {
    const extractor = extractionModel();
    const factory = vi.fn(() => extractor.model);
    vi.stubGlobal("AI_SDK_DEFAULT_PROVIDER", { extractionModel: factory });

    await extract({ model: "internal-extractor", state, fields });

    expect(factory.mock.calls).toEqual([["internal-extractor"]]);
  });

  it("translates stable request options for explicit provider model instances", async () => {
    const extractor = extractionModel();
    const abortSignal = new AbortController().signal;
    await extract({
      model: extractor.model,
      state,
      fields,
      referenceDate: "2026-11-24",
      signal: abortSignal,
      maxRetries: 0,
      providerOptions: { gateway: { zeroDataRetention: true } },
    });

    expect(localExtractionModel).not.toHaveBeenCalled();
    expect(extractor.doExtract).toHaveBeenCalledWith(
      expect.objectContaining({
        state: [{ type: "text", text: state }],
        fields,
        referenceDate: "2026-11-24",
        abortSignal,
        providerOptions: { gateway: { zeroDataRetention: true } },
      }),
    );
  });

  it("rejects identity-only objects, unsupported versions, and unsupported fields before provider I/O", async () => {
    await expect(
      extract({
        // @ts-expect-error Identity alone is not a provider implementation.
        model: { provider: "fixture", modelId: "missing", specificationVersion: "v4" },
        state,
        fields,
      }),
    ).rejects.toThrow("not just its identity");
    const extractor = extractionModel();
    const newerModel = { ...extractor.model, specificationVersion: "v-next" };
    await expect(
      // @ts-expect-error Only the specification versions the AI SDK supports are accepted.
      extract({ model: newerModel, state, fields }),
    ).rejects.toThrow(/version/i);
    const textOnly = new Experimental_ExtractionMockModelV4({
      supportedFieldTypes: ["text", "list"],
      doExtract: extractor.doExtract,
    });
    await expect(extract({ model: textOnly, state, fields })).rejects.toMatchObject({
      fieldId: "total",
      fieldType: "number",
    });
    expect(extractor.doExtract).not.toHaveBeenCalled();
  });

  it("preserves input and answer validation", async () => {
    const extractor = extractionModel();
    await expect(extract({ model: extractor.model, state, fields: {} })).rejects.toThrow();
    await expect(
      extract({ model: extractor.model, state, fields, referenceDate: "November 24" }),
    ).rejects.toThrow("referenceDate");
    expect(extractor.doExtract).not.toHaveBeenCalled();

    const invalid = new Experimental_ExtractionMockModelV4({
      doExtract: async () => ({ answers: {}, warnings: [] }),
    });
    await expect(extract({ model: invalid, state, fields })).rejects.toThrow("exactly one answer");
  });

  it("reports refused fields as an extraction refusal", async () => {
    const refusing = new Experimental_ExtractionMockModelV4({
      doExtract: async () => ({
        answers: { invoiceNumber: { type: "refusal" } },
        warnings: [],
      }),
    });
    await expect(
      extract({ model: refusing, state, fields: { invoiceNumber: fields.invoiceNumber } }),
    ).rejects.toMatchObject({ fieldIds: ["invoiceNumber"] });
  });

  it("propagates provider errors and aborts before provider I/O", async () => {
    const error = new Error("Extraction unavailable.");
    const failed = new Experimental_ExtractionMockModelV4({
      doExtract: async () => {
        throw error;
      },
    });
    await expect(extract({ model: failed, state, fields, maxRetries: 0 })).rejects.toBe(error);

    const extractor = extractionModel();
    await expect(
      extract({ model: extractor.model, state, fields, signal: AbortSignal.abort(error) }),
    ).rejects.toBe(error);
    expect(extractor.doExtract).not.toHaveBeenCalled();
  });
});
