import { beforeEach, describe, expect, it, vi } from "vitest";

import { reportDroppedWirePayloadStep } from "#execution/report-dropped-wire-payload-step.js";
import { createSessionCommandRouter } from "#execution/session-command-router.js";

vi.mock("./report-dropped-wire-payload-step.js", () => ({
  reportDroppedWirePayloadStep: vi.fn(),
}));

describe("createSessionCommandRouter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("decodes ordinary session commands", async () => {
    const router = createSessionCommandRouter();

    await expect(
      router.route({ kind: "send", payload: { message: "hello" } }),
    ).resolves.toMatchObject({ kind: "deliver", payloads: [{ message: "hello" }] });
  });

  it("drops invalid wire payloads with an operator-visible report", async () => {
    const router = createSessionCommandRouter();

    await expect(
      router.route({ kind: "deliver", payloads: [], version: 99 } as never),
    ).resolves.toBeUndefined();
    expect(reportDroppedWirePayloadStep).toHaveBeenCalledOnce();
  });
});
