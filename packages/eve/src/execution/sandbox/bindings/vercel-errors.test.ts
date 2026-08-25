import { describe, expect, it } from "vitest";

import { isVercelCommandStreamInterruptedError } from "./vercel-errors.js";

describe("isVercelCommandStreamInterruptedError", () => {
  it.each(["sandbox_stream_closed", "stream_ended_early", "UND_ERR_SOCKET"])(
    "recognizes %s through a cause chain",
    (code) => {
      expect(
        isVercelCommandStreamInterruptedError(
          new Error("wrapped", { cause: Object.assign(new Error("transport"), { code }) }),
        ),
      ).toBe(true);
    },
  );

  it("recognizes undici's terminated fetch error", () => {
    expect(isVercelCommandStreamInterruptedError(new TypeError("terminated"))).toBe(true);
  });

  it("does not classify command failures as transport interruptions", () => {
    expect(isVercelCommandStreamInterruptedError(new Error("command exited with code 1"))).toBe(
      false,
    );
  });
});
