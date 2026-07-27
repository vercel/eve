import { describe, expect, it } from "vitest";

import { toolOutput, toolOutputPart } from "#public/tools/output-builders.js";
import { normalizeToolJsonOutput, normalizeToolModelOutput } from "#harness/tool-model-output.js";

function normalize(output: unknown): unknown {
  return normalizeToolModelOutput({ output, toolCallId: "call_1", toolName: "screenshot" });
}

describe("normalizeToolJsonOutput", () => {
  it("normalizes top-level undefined to null", () => {
    expect(
      normalizeToolJsonOutput({ boundary: "execute", output: undefined, toolName: "echo" }),
    ).toBeNull();
  });

  it("rejects non-JSON-serializable values with the boundary in the error", () => {
    expect(() =>
      normalizeToolJsonOutput({
        boundary: "execute",
        output: { now: new Date("2026-01-02T03:04:05.000Z") },
        toolCallId: "call_timestamp",
        toolName: "timestamp",
      }),
    ).toThrow(
      'Tool "timestamp" call "call_timestamp" returned a non-JSON-serializable result. ' +
        "Expected a JSON-serializable value.",
    );
  });
});

describe("normalizeToolModelOutput", () => {
  it("normalizes a content output of text and file parts into the AI SDK shape", () => {
    const pixel =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

    expect(
      normalize({
        type: "content",
        value: [
          { type: "text", text: "Screenshot:" },
          {
            type: "file",
            data: { type: "data", data: pixel },
            mediaType: "image/png",
            filename: "pixel.png",
          },
        ],
      }),
    ).toEqual({
      type: "content",
      value: [
        { type: "text", text: "Screenshot:" },
        {
          type: "file",
          data: { type: "data", data: pixel },
          mediaType: "image/png",
          filename: "pixel.png",
        },
      ],
    });
  });

  it("accepts outputs built with the toolOutput builders", () => {
    expect(normalize(toolOutput.text("visible"))).toEqual({ type: "text", value: "visible" });
    expect(normalize(toolOutput.json({ summary: "ok" }))).toEqual({
      type: "json",
      value: { summary: "ok" },
    });
    expect(
      normalize(
        toolOutput.content([
          toolOutputPart.text("Screenshot:"),
          toolOutputPart.file("aGVsbG8=", { mediaType: "image/png" }),
        ]),
      ),
    ).toEqual({
      type: "content",
      value: [
        { type: "text", text: "Screenshot:" },
        { type: "file", data: { type: "data", data: "aGVsbG8=" }, mediaType: "image/png" },
      ],
    });
  });

  it.each([
    [
      "raw Uint8Array payload",
      { type: "data", data: new Uint8Array([1, 2, 3]) },
      /base64 string, received raw bytes/u,
    ],
    ["raw untagged bytes", new Uint8Array([1, 2, 3]), /base64 string, received raw bytes/u],
    [
      "url file-data tag",
      { type: "url", url: "https://example.com/a.png" },
      /"url" is not supported yet/u,
    ],
    [
      "reference file-data tag",
      { type: "reference", reference: "file_abc" },
      /"reference" is not supported yet/u,
    ],
    ["text file-data tag", { type: "text", text: "inline" }, /"text" is not supported yet/u],
    ["untagged string data", "aGVsbG8=", /expected object, received string at "value\[0\]\.data"/u],
  ] as const)("rejects content file parts with %s", (_label, data, expected) => {
    expect(() =>
      normalize({ type: "content", value: [{ type: "file", data, mediaType: "image/png" }] }),
    ).toThrow(expected);
  });

  it("rejects empty content part arrays with the toModelOutput error identity", () => {
    expect(() => normalize({ type: "content", value: [] })).toThrow(
      'Tool "screenshot" call "call_1" returned a non-JSON-serializable model output. ' +
        'Too small: expected array to have >=1 items at "value"',
    );
  });

  it("rejects unknown content part types", () => {
    expect(() =>
      normalize({
        type: "content",
        value: [{ type: "media", data: "aGVsbG8=", mediaType: "image/png" }],
      }),
    ).toThrow(/Invalid discriminator value. Expected 'text' \| 'file' at "value\[0\]\.type"/u);
  });

  it("rejects unknown output types", () => {
    expect(() => normalize({ type: "markdown", value: "# nope" })).toThrow(
      /Invalid discriminator value. Expected 'text' \| 'json' \| 'content' at "type"/u,
    );
  });
});
