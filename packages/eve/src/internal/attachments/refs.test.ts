import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_REF_SCHEME,
  ATTACHMENT_REF_WIRE_VERSION,
  type AttachmentRef,
  encodeAttachmentRef,
  isAttachmentRefUrl,
  parseAttachmentRef,
} from "#internal/attachments/refs.js";

interface SlackParams {
  readonly file_id: string;
  readonly url: string;
}

describe("encodeAttachmentRef", () => {
  it("builds an eve-attachment: URL with a v=1 version and a base64url JSON payload", () => {
    const ref: AttachmentRef<SlackParams> = {
      params: { file_id: "F123ABC", url: "https://files.slack.com/report.csv" },
      size: 13319,
    };

    const url = encodeAttachmentRef(ref);

    expect(url.protocol).toBe(ATTACHMENT_REF_SCHEME);
    expect(url.searchParams.get("v")).toBe(ATTACHMENT_REF_WIRE_VERSION);

    const payload = url.searchParams.get("p");
    expect(payload).not.toBeNull();
    const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
    expect(decoded).toEqual({
      params: { file_id: "F123ABC", url: "https://files.slack.com/report.csv" },
      size: 13319,
    });
  });

  it("omits size from the payload when unset", () => {
    const url = encodeAttachmentRef({ params: { url: "u" } });
    const payload = url.searchParams.get("p");
    const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
    expect(decoded).toEqual({ params: { url: "u" } });
    expect("size" in decoded).toBe(false);
  });

  it("encodes typed params with numbers, booleans, and nested objects", () => {
    interface Custom {
      readonly blob_key: string;
      readonly is_private: boolean;
      readonly revision: number;
      readonly meta: { readonly author: string };
    }
    const ref: AttachmentRef<Custom> = {
      params: { blob_key: "k", is_private: true, revision: 7, meta: { author: "alice" } },
    };
    const parsed = parseAttachmentRef<Custom>(encodeAttachmentRef(ref));
    expect(parsed.params).toEqual({
      blob_key: "k",
      is_private: true,
      revision: 7,
      meta: { author: "alice" },
    });
  });

  it("rejects a non-integer size", () => {
    expect(() => encodeAttachmentRef({ params: {}, size: 1.5 })).toThrow(/non-negative integer/u);
  });

  it("rejects a negative size", () => {
    expect(() => encodeAttachmentRef({ params: {}, size: -1 })).toThrow(/non-negative integer/u);
  });

  it("rejects a non-finite size", () => {
    expect(() => encodeAttachmentRef({ params: {}, size: Number.POSITIVE_INFINITY })).toThrow(
      /non-negative integer/u,
    );
  });
});

describe("parseAttachmentRef", () => {
  it("round-trips encode → parse preserving params and size", () => {
    const input: AttachmentRef<SlackParams> = {
      params: { file_id: "F123", url: "https://files.slack.com/x" },
      size: 42,
    };

    const parsed = parseAttachmentRef<SlackParams>(encodeAttachmentRef(input));

    expect(parsed.params).toEqual({ file_id: "F123", url: "https://files.slack.com/x" });
    expect(parsed.size).toBe(42);
  });

  it("omits size on the parsed ref when the payload carries no size", () => {
    const ref = parseAttachmentRef(encodeAttachmentRef({ params: { url: "u" } }));
    expect(ref.size).toBeUndefined();
  });

  it("rejects non-eve-attachment schemes", () => {
    expect(() => parseAttachmentRef(new URL("https://files.slack.com/x"))).toThrow(
      /eve-attachment:/u,
    );
    expect(() => parseAttachmentRef(new URL("data:,hello"))).toThrow(/eve-attachment:/u);
  });

  it("rejects a missing or unrecognized wire version", () => {
    expect(() => parseAttachmentRef(new URL("eve-attachment:?p=eyJwYXJhbXMiOnt9fQ"))).toThrow(
      /wire format version/u,
    );
    expect(() => parseAttachmentRef(new URL("eve-attachment:?v=2&p=eyJwYXJhbXMiOnt9fQ"))).toThrow(
      /wire format version/u,
    );
  });

  it("rejects a missing payload", () => {
    expect(() => parseAttachmentRef(new URL("eve-attachment:?v=1"))).toThrow(/"p" payload/u);
  });

  it("rejects a payload that is not base64url-encoded JSON", () => {
    expect(() => parseAttachmentRef(new URL("eve-attachment:?v=1&p=!!!notjson!!!"))).toThrow(
      /base64url-encoded JSON/u,
    );
  });

  it("rejects a payload that decodes to a non-object", () => {
    const encoded = Buffer.from(JSON.stringify("literal"), "utf8").toString("base64url");
    expect(() => parseAttachmentRef(new URL(`eve-attachment:?v=1&p=${encoded}`))).toThrow(
      /JSON object/u,
    );
  });

  it("rejects a payload missing the params field", () => {
    const encoded = Buffer.from(JSON.stringify({ size: 1 }), "utf8").toString("base64url");
    expect(() => parseAttachmentRef(new URL(`eve-attachment:?v=1&p=${encoded}`))).toThrow(
      /"params" field/u,
    );
  });

  it("rejects a payload with a malformed size", () => {
    for (const size of [-1, 1.5, "42"]) {
      const encoded = Buffer.from(JSON.stringify({ params: {}, size }), "utf8").toString(
        "base64url",
      );
      expect(() => parseAttachmentRef(new URL(`eve-attachment:?v=1&p=${encoded}`))).toThrow(
        /non-negative integer/u,
      );
    }
  });
});

describe("isAttachmentRefUrl", () => {
  it("returns true only for URL instances with the eve-attachment scheme", () => {
    expect(isAttachmentRefUrl(encodeAttachmentRef({ params: { url: "u" } }))).toBe(true);
    expect(isAttachmentRefUrl(new URL("https://example.com"))).toBe(false);
    expect(isAttachmentRefUrl(new URL("data:,hello"))).toBe(false);
  });

  it("rejects string inputs even when they look like attachment refs", () => {
    expect(isAttachmentRefUrl("eve-attachment:?v=1&p=eyJwYXJhbXMiOnt9fQ")).toBe(false);
  });

  it("rejects non-URL inputs", () => {
    expect(isAttachmentRefUrl(null)).toBe(false);
    expect(isAttachmentRefUrl(undefined)).toBe(false);
    expect(isAttachmentRefUrl({})).toBe(false);
    expect(isAttachmentRefUrl(42)).toBe(false);
  });
});
