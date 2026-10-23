import { describe, expect, it } from "vitest";
import { withoutReportHash } from "./privacy";

describe("withoutReportHash", () => {
  it("drops the report from review page URLs", () => {
    expect(withoutReportHash({ url: "https://eve.dev/agent-feedback#report=abc" })).toEqual({
      url: "https://eve.dev/agent-feedback",
    });
    expect(withoutReportHash({ url: "https://eve.dev/en/agent-feedback#report=abc" }).url).toBe(
      "https://eve.dev/en/agent-feedback",
    );
  });

  it("leaves other pages alone", () => {
    const event = { url: "https://eve.dev/docs/channels#slack" };
    expect(withoutReportHash(event)).toBe(event);
  });
});
