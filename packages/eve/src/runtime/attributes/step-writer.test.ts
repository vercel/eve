import { beforeEach, describe, expect, it, vi } from "vitest";

import { setEveAttributes } from "#runtime/attributes/emit.js";
import { createStepAttributeWriter } from "#runtime/attributes/step-writer.js";

vi.mock("./emit.js", () => ({ setEveAttributes: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

describe("createStepAttributeWriter", () => {
  it("starts the first write immediately and preserves write order", async () => {
    let finishTitle!: () => void;
    vi.mocked(setEveAttributes)
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          finishTitle = resolve;
        }),
      )
      .mockResolvedValueOnce(undefined);
    const writer = createStepAttributeWriter();

    writer.enqueue({ "$eve.title": "A title" });
    await vi.waitFor(() => expect(setEveAttributes).toHaveBeenCalledOnce());
    const usage = writer.write({ "$eve.model": "openai/gpt-5" });
    expect(setEveAttributes).toHaveBeenCalledOnce();

    finishTitle();
    await usage;
    expect(vi.mocked(setEveAttributes).mock.calls).toEqual([
      [{ "$eve.title": "A title" }],
      [{ "$eve.model": "openai/gpt-5" }],
    ]);
  });

  it("flushes an enqueued write", async () => {
    let finish!: () => void;
    vi.mocked(setEveAttributes).mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const writer = createStepAttributeWriter();
    writer.enqueue({ "$eve.title": "A title" });

    let flushed = false;
    const flush = writer.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);

    finish();
    await flush;
    expect(flushed).toBe(true);
  });
});
