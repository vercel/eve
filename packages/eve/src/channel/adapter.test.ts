import { describe, expect, it } from "vitest";

import type { ChannelAdapter, ChannelAdapterContext, FetchFileResult } from "#channel/adapter.js";
import { callAdapterEventHandler, defaultDeliverResult, getAdapterKind } from "#channel/adapter.js";
import { createSessionWaitingEvent } from "#protocol/message.js";

describe("ChannelAdapter (fetchFile field)", () => {
  it("treats the fetchFile field as optional", () => {
    const adapter: ChannelAdapter = { kind: "noop" };
    expect(adapter.fetchFile).toBeUndefined();
  });

  it("accepts a fetchFile function that returns a Buffer", async () => {
    const adapter: ChannelAdapter = {
      kind: "custom",
      async fetchFile(url) {
        return Buffer.from(`url=${url}`);
      },
    };

    const result = await adapter.fetchFile!("https://example.com/file");
    const bytes = Buffer.isBuffer(result) ? result : result!.bytes;
    expect(bytes.toString("utf8")).toBe("url=https://example.com/file");
  });

  it("accepts a fetchFile function that returns a FetchFileResult", async () => {
    const adapter: ChannelAdapter = {
      kind: "custom",
      async fetchFile(url) {
        const resolved: FetchFileResult = {
          bytes: Buffer.from(`url=${url}`),
          filename: "test.txt",
          mediaType: "text/plain",
        };
        return resolved;
      },
    };

    const result = await adapter.fetchFile!("https://example.com/file");
    expect(Buffer.isBuffer(result)).toBe(false);
    expect(result).not.toBeNull();
    const resolved = result as FetchFileResult;
    expect(resolved.bytes.toString("utf8")).toBe("url=https://example.com/file");
    expect(resolved.mediaType).toBe("text/plain");
    expect(resolved.filename).toBe("test.txt");
  });

  it("accepts a fetchFile function that returns null", async () => {
    const adapter: ChannelAdapter = {
      kind: "custom",
      async fetchFile(_url) {
        return null;
      },
    };

    const result = await adapter.fetchFile!("https://example.com/unknown");
    expect(result).toBeNull();
  });
});

describe("ChannelAdapter helpers", () => {
  it("getAdapterKind returns the declared kind", () => {
    expect(getAdapterKind({ kind: "slack" })).toBe("slack");
  });

  it("defaultDeliverResult passes both message and inputResponses through", () => {
    expect(defaultDeliverResult({ message: "hi" })).toEqual({
      inputResponses: undefined,
      message: "hi",
      context: undefined,
    });
  });

  it("defaultDeliverResult forwards context with message payloads", () => {
    const context = ["thread background"];

    expect(defaultDeliverResult({ message: "hi", context })).toEqual({
      inputResponses: undefined,
      message: "hi",
      context,
    });
  });

  it("defaultDeliverResult forwards context with inputResponses payloads", () => {
    const context = ["thread background"];
    const inputResponses = [{ requestId: "req-1", text: "yes" }];

    expect(defaultDeliverResult({ inputResponses, context })).toEqual({
      inputResponses,
      context,
    });
  });

  it("defaultDeliverResult accepts context-only payloads", () => {
    const context = ["thread background"];

    expect(defaultDeliverResult({ context })).toEqual({ context });
  });

  it("defaultDeliverResult returns undefined when the payload is empty", () => {
    expect(defaultDeliverResult({})).toBeUndefined();
  });

  it("publishes a continuation token re-keyed by the waiting handler", async () => {
    let continuationToken = "slack:temporary";
    const context: ChannelAdapterContext = {
      ctx: {} as ChannelAdapterContext["ctx"],
      session: {
        auth: { current: null, initiator: null },
        get continuationToken() {
          return continuationToken;
        },
        id: "session-1",
        setContinuationToken(token) {
          continuationToken = `slack:${token}`;
        },
      },
      state: {},
    };
    const adapter: ChannelAdapter = {
      kind: "slack",
      "session.waiting"(_data, ctx) {
        ctx.session.setContinuationToken("C1:T1");
      },
    };

    const event = await callAdapterEventHandler(
      adapter,
      createSessionWaitingEvent("slack:temporary"),
      context,
    );

    expect(event).toEqual({
      data: { continuationToken: "C1:T1", wait: "next-user-message" },
      type: "session.waiting",
    });
  });
});
