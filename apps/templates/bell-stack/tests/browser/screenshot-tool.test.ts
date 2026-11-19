import type { ToolModelOutputContext } from "eve/tools";
import { describe, expect, it } from "vitest";

import screenshot from "../../agent/tools/screenshot";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS2kAAAAASUVORK5CYII=";
const modelOutputContext: ToolModelOutputContext = {
  callId: "call-1",
  defaultModelOutput: (output) => ({ type: "json", value: output }),
  getSandbox: async () => undefined,
  warnOnce: () => {},
  toolName: "screenshot",
};
const workbench = {
  browser: { provider: "local" as const, status: "active" as const },
  traces: [],
};

describe("screenshot model output", () => {
  it("includes the captured PNG as model-visible image content", async () => {
    const output = await screenshot.toModelOutput!(
      {
        result: { mediaType: "image/png", data: png, url: "https://shop.example/account" },
        workbench,
      },
      modelOutputContext,
    );
    expect(output).toEqual({
      type: "content",
      value: [
        { type: "text", text: "Screenshot of https://shop.example/account" },
        { type: "file", data: { type: "data", data: png }, mediaType: "image/png" },
      ],
    });
    expect(JSON.parse(JSON.stringify(output))).toEqual(output);
  });

  it("preserves a CAPTCHA handoff when no screenshot was captured", async () => {
    const result = { status: "waiting_for_user", reason: "captcha" };
    expect(
      await screenshot.toModelOutput!({ result, workbench } as never, modelOutputContext),
    ).toEqual({
      type: "json",
      value: result,
    });
  });
});
