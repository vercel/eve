import { expect, it } from "vitest";
import { normalizeChannelCors } from "#channel/cors.js";

it.each(["https://client.example", ["https://client.example"]])(
  "normalizes a declared origin to the compiled origin list: %j",
  (origin) => {
    expect(normalizeChannelCors({ origin })).toEqual({ origin: ["https://client.example"] });
  },
);

it("rejects an empty single origin rather than compiling an unusable policy", () => {
  expect(() => normalizeChannelCors({ origin: "" })).toThrow(/non-empty origin/);
});

it.each([
  [
    { allowedHeaders: ["x-api-key"] },
    /"allowedHeaders" is no longer supported\. Use "allowHeaders"/,
  ],
  [{ exposedHeaders: ["x-eve"] }, /"exposedHeaders" is no longer supported\. Use "exposeHeaders"/],
  [
    { preflightStatus: 204 },
    /"preflightStatus" is no longer supported\. Use "preflight\.statusCode"/,
  ],
  [
    { allowHeader: ["x-api-key"] },
    /Unknown channel cors option "allowHeader"\. Supported options: .*allowHeaders/,
  ],
])("rejects an unsupported option instead of falling back to defaults: %j", (cors, message) => {
  expect(() => normalizeChannelCors(cors as never)).toThrow(message);
});
