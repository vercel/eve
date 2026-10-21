import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ attempt: 1 as number | undefined }));

vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#compiled/@workflow/core/index.js")>()),
  getStepMetadata: () => {
    if (mocks.attempt === undefined) throw new Error("not in a step");
    return { attempt: mocks.attempt };
  },
}));

const { refuseOnReplay, ToolRecoveryRequiredError } = await import("./tool-replay.js");

describe("refuseOnReplay", () => {
  beforeEach(() => {
    mocks.attempt = 1;
  });

  it("runs the tool on the step's first attempt", async () => {
    const execute = vi.fn(async (input: string) => `sent ${input}`);
    await expect(refuseOnReplay("send_email", execute)("hi")).resolves.toBe("sent hi");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("refuses the tool when its durable step runs again", () => {
    mocks.attempt = 2;
    const execute = vi.fn();
    expect(() => refuseOnReplay("send_email", execute)()).toThrow(ToolRecoveryRequiredError);
    expect(() => refuseOnReplay("send_email", execute)()).toThrow(/TOOL_RECOVERY_REQUIRED/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("runs the tool outside a durable step", () => {
    mocks.attempt = undefined;
    const execute = vi.fn(() => "ok");
    expect(refuseOnReplay("send_email", execute)()).toBe("ok");
  });
});
