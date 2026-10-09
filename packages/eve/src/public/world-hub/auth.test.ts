import { describe, expect, it } from "vitest";
import { signWorldHubRequest, verifyWorldHubRequest } from "./auth.js";
describe("World hub HMAC", () => {
  it("validates signatures and rejects tampering and skew", () => {
    const now = Date.now();
    const headers = new Headers(
      signWorldHubRequest("secret", "POST", "/world/v1/rpc", "body", String(now)),
    );
    expect(verifyWorldHubRequest("secret", "POST", "/world/v1/rpc", "body", headers, now)).toBe(
      true,
    );
    expect(verifyWorldHubRequest("wrong", "POST", "/world/v1/rpc", "body", headers, now)).toBe(
      false,
    );
    expect(verifyWorldHubRequest("secret", "POST", "/world/v1/rpc", "tampered", headers, now)).toBe(
      false,
    );
    expect(
      verifyWorldHubRequest("secret", "POST", "/world/v1/rpc", "body", headers, now + 300001),
    ).toBe(false);
    expect(verifyWorldHubRequest("secret", "GET", "/world/v1/rpc", "body", headers, now)).toBe(
      false,
    );
  });
});

it.each([
  "x-world-hub-deployment-id",
  "x-world-hub-deployment-url",
  "x-vqs-queue-name",
  "x-vqs-message-id",
  "x-vqs-message-attempt",
])("authenticates %s including removal", (name) => {
  const headers = new Headers(
    signWorldHubRequest(
      "secret",
      "POST",
      "/dispatch",
      "body",
      undefined,
      new Headers({ [name]: "original" }),
    ),
  );
  expect(verifyWorldHubRequest("secret", "POST", "/dispatch", "body", headers)).toBe(true);
  headers.set(name, "tampered");
  expect(verifyWorldHubRequest("secret", "POST", "/dispatch", "body", headers)).toBe(false);
  headers.delete(name);
  expect(verifyWorldHubRequest("secret", "POST", "/dispatch", "body", headers)).toBe(false);
});
it("rejects the unsigned-metadata v1 scheme", () => {
  const headers = new Headers(signWorldHubRequest("secret", "GET", "/"));
  headers.set("x-world-hub-signature", headers.get("x-world-hub-signature")!.replace("v2=", "v1="));
  expect(verifyWorldHubRequest("secret", "GET", "/", "", headers)).toBe(false);
});

it("uses the SDK session stream name", async () => {
  const { sessionStreamName } = await import("./server.js");
  expect(sessionStreamName("wrun_abc")).toBe("strm_abc_user");
});
it("round trips stored NDJSON session events", async () => {
  const { decodeSessionStreamChunk } = await import("./server.js");
  const { getSerializeStream, getWorkflowReducers } =
    await import("#compiled/@workflow/core/serialization.js");
  const event = { type: "text-delta", text: "hello \u4e16\u754c" };
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n"));
      controller.close();
    },
  });
  const serialized = source.pipeThrough(
    getSerializeStream(getWorkflowReducers(globalThis), undefined),
  );
  for await (const chunk of serialized)
    expect(await decodeSessionStreamChunk(chunk)).toEqual([event]);
});
