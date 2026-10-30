import { describe, expect, it } from "vitest";

import { readJsonBody } from "./json-body.js";

function post(body: string | null, headers: Record<string, string> = {}): Request {
  return new Request("https://agent.example.com/rpc", { body, headers, method: "POST" });
}

describe("readJsonBody", () => {
  it("parses JSON and reports an absent body as empty", async () => {
    expect(await readJsonBody(post('{"a":1}'), 100)).toEqual({ kind: "json", value: { a: 1 } });
    expect(await readJsonBody(post(null), 100)).toEqual({ kind: "empty" });
    expect(await readJsonBody(post("{"), 100)).toEqual({ kind: "invalid-json" });
  });

  it("refuses a body over the cap, whatever length it declares", async () => {
    const large = JSON.stringify({ text: "x".repeat(200) });
    expect(await readJsonBody(post(large), 100)).toEqual({ kind: "too-large" });
    expect(await readJsonBody(post("{}", { "content-length": "1000" }), 100)).toEqual({
      kind: "too-large",
    });
  });
});
