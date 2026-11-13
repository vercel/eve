import { describe, expect, it } from "vitest";

import { redactText, redactValue } from "../../server/browser/redact.js";

describe("trace redaction", () => {
  it("removes Browserbase and model keys", () => {
    const text = redactText(
      "BROWSERBASE_API_KEY=bb_live_abcdefghijkl OPENAI_API_KEY=sk-abcdefghijklmnop",
    );
    expect(text).not.toContain("bb_live_abcdefghijkl");
    expect(text).not.toContain("sk-abcdefghijklmnop");
  });

  it("redacts nested values", () => {
    const result = redactValue({ input: { password: "password=hunter2" } });
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("redacts sensitive fields even when their values have no recognizable pattern", () => {
    const input = { password: "arbitrary-one", headers: { Authorization: "arbitrary-two", Cookie: "arbitrary-three" }, access_token: "arbitrary-four", cardNumber: "4242424242424242", cvc: "123" };
    expect(redactValue(input)).toEqual({ password: "[REDACTED]", headers: { Authorization: "[REDACTED]", Cookie: "[REDACTED]" }, access_token: "[REDACTED]", cardNumber: "[REDACTED]", cvc: "[REDACTED]" });
  });

  it("hides every entered form value while preserving useful action metadata", () => {
    const actions = ["fill", "type", "select"].map(action => ({ action, target: "#field", value: "synthetic-private-value" }));
    const output = redactValue({ actions });
    expect(output.actions).toEqual(actions.map(action => ({ ...action, value: "[value hidden]" })));
    expect(actions[0].value).toBe("synthetic-private-value");
    expect(redactValue({ action: "press", key: "s" })).toEqual({ action: "press", key: "[key hidden]" });
  });
});
