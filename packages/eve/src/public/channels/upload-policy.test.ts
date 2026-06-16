import type { FilePart, UserContent } from "ai";
import { describe, expect, it } from "vitest";

import {
  collectUploadPolicyViolations,
  DEFAULT_UPLOAD_POLICY,
  evaluateFilePart,
  formatUploadPolicyViolation,
  isMediaTypeAllowed,
  isUploadsDisabled,
  mergeUploadPolicy,
  stripDisallowedFileParts,
  type UploadPolicy,
  type UploadPolicyConfig,
  type UploadPolicyViolation,
} from "#public/channels/upload-policy.js";

const KILOBYTE = 1024;

function makeBytes(byteCount: number): Uint8Array {
  return new Uint8Array(byteCount).fill(0x61);
}

function filePart(overrides: Partial<FilePart> = {}): FilePart {
  return {
    data: overrides.data ?? makeBytes(32),
    filename: overrides.filename ?? "report.csv",
    mediaType: overrides.mediaType ?? "text/csv",
    type: "file",
  };
}

describe("DEFAULT_UPLOAD_POLICY", () => {
  it("caps uploads at 25 MB with no media-type restriction", () => {
    expect(DEFAULT_UPLOAD_POLICY.maxBytes).toBe(25 * 1024 * 1024);
    expect(DEFAULT_UPLOAD_POLICY.allowedMediaTypes).toBe("*");
  });

  it("is frozen so consumers cannot mutate the shared default", () => {
    expect(Object.isFrozen(DEFAULT_UPLOAD_POLICY)).toBe(true);
  });
});

describe("mergeUploadPolicy", () => {
  it("returns the base policy when no override is provided", () => {
    const merged = mergeUploadPolicy();
    expect(merged).toEqual(DEFAULT_UPLOAD_POLICY);
  });

  it("merges field-by-field with the framework default", () => {
    expect(mergeUploadPolicy({ maxBytes: 4 * KILOBYTE })).toEqual({
      allowedMediaTypes: "*",
      maxBytes: 4 * KILOBYTE,
    });
  });

  it("preserves explicit allowlist arrays", () => {
    expect(mergeUploadPolicy({ allowedMediaTypes: ["image/png", "text/*"] })).toEqual({
      allowedMediaTypes: ["image/png", "text/*"],
      maxBytes: DEFAULT_UPLOAD_POLICY.maxBytes,
    });
  });

  it("accepts a custom base policy", () => {
    const base: UploadPolicyConfig = {
      allowedMediaTypes: ["text/plain"],
      maxBytes: KILOBYTE,
    };
    const merged = mergeUploadPolicy({ maxBytes: 2 * KILOBYTE }, base);

    expect(merged).toEqual({ allowedMediaTypes: ["text/plain"], maxBytes: 2 * KILOBYTE });
  });

  it("rejects non-finite maxBytes", () => {
    expect(() => mergeUploadPolicy({ maxBytes: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    expect(() => mergeUploadPolicy({ maxBytes: Number.NaN })).toThrow(RangeError);
  });

  it("rejects negative maxBytes", () => {
    expect(() => mergeUploadPolicy({ maxBytes: -1 })).toThrow(RangeError);
  });

  it("passes the 'disabled' literal through", () => {
    expect(mergeUploadPolicy("disabled")).toBe("disabled");
  });
});

describe("isUploadsDisabled", () => {
  it.each([
    ["'disabled' literal", "disabled" as UploadPolicy],
    ["maxBytes: 0", { allowedMediaTypes: "*", maxBytes: 0 } satisfies UploadPolicy],
    ["empty allowedMediaTypes", { allowedMediaTypes: [], maxBytes: 1 } satisfies UploadPolicy],
  ])("returns true for %s", (_label, policy) => {
    expect(isUploadsDisabled(policy)).toBe(true);
  });

  it("returns false for the framework default", () => {
    expect(isUploadsDisabled(DEFAULT_UPLOAD_POLICY)).toBe(false);
  });

  it("returns false for a non-empty allowlist with a positive cap", () => {
    expect(isUploadsDisabled({ allowedMediaTypes: ["image/*"], maxBytes: 1024 })).toBe(false);
  });
});

describe("isMediaTypeAllowed", () => {
  const wildcardPolicy: UploadPolicy = { allowedMediaTypes: "*", maxBytes: 1 };
  const exactPolicy: UploadPolicy = {
    allowedMediaTypes: ["text/csv", "application/pdf"],
    maxBytes: 1,
  };
  const prefixPolicy: UploadPolicy = {
    allowedMediaTypes: ["image/*"],
    maxBytes: 1,
  };

  it("accepts anything when the allowlist is *", () => {
    expect(isMediaTypeAllowed("image/png", wildcardPolicy)).toBe(true);
    expect(isMediaTypeAllowed("application/x-tar", wildcardPolicy)).toBe(true);
  });

  it("matches exact entries case-insensitively", () => {
    expect(isMediaTypeAllowed("text/csv", exactPolicy)).toBe(true);
    expect(isMediaTypeAllowed("TEXT/CSV", exactPolicy)).toBe(true);
    expect(isMediaTypeAllowed("application/pdf", exactPolicy)).toBe(true);
  });

  it("rejects types outside the exact allowlist", () => {
    expect(isMediaTypeAllowed("image/png", exactPolicy)).toBe(false);
  });

  it("matches trailing-wildcard patterns", () => {
    expect(isMediaTypeAllowed("image/png", prefixPolicy)).toBe(true);
    expect(isMediaTypeAllowed("image/jpeg", prefixPolicy)).toBe(true);
    expect(isMediaTypeAllowed("video/mp4", prefixPolicy)).toBe(false);
  });

  it("rejects everything when the policy is 'disabled'", () => {
    expect(isMediaTypeAllowed("image/png", "disabled")).toBe(false);
    expect(isMediaTypeAllowed("text/plain", "disabled")).toBe(false);
  });
});

describe("evaluateFilePart", () => {
  it("returns null when the part is within policy", () => {
    const part = filePart();
    const result = evaluateFilePart(part, DEFAULT_UPLOAD_POLICY);
    expect(result).toBeNull();
  });

  it("reports disallowed media types before size", () => {
    const oversized = filePart({ data: makeBytes(10), mediaType: "image/gif" });
    const policy: UploadPolicy = {
      allowedMediaTypes: ["text/csv"],
      maxBytes: 1,
    };
    const result = evaluateFilePart(oversized, policy);

    expect(result).not.toBeNull();
    expect(result?.kind).toBe("disallowed-media-type");
    if (result?.kind === "disallowed-media-type") {
      expect(result.mediaType).toBe("image/gif");
      expect(result.allowedMediaTypes).toEqual(["text/csv"]);
    }
  });

  it("reports size violations with byteLength and limit", () => {
    const policy: UploadPolicy = { allowedMediaTypes: "*", maxBytes: 4 };
    const part = filePart({ data: makeBytes(16) });
    const result = evaluateFilePart(part, policy);

    expect(result).not.toBeNull();
    expect(result?.kind).toBe("too-large");
    if (result?.kind === "too-large") {
      expect(result.byteLength).toBe(16);
      expect(result.limit).toBe(4);
      expect(result.filename).toBe("report.csv");
    }
  });

  it("omits filename from the violation when the part has none", () => {
    const policy: UploadPolicy = { allowedMediaTypes: "*", maxBytes: 4 };
    const part: FilePart = {
      data: makeBytes(16),
      mediaType: "application/octet-stream",
      type: "file",
    };
    const result = evaluateFilePart(part, policy);

    expect(result?.kind).toBe("too-large");
    expect(result?.filename).toBeUndefined();
  });

  it("defers remote URL parts to the provider (no size check possible)", () => {
    const policy: UploadPolicy = { allowedMediaTypes: "*", maxBytes: 1 };
    const part = filePart({
      data: new URL("https://example.com/huge.bin"),
      mediaType: "application/octet-stream",
    });
    const result = evaluateFilePart(part, policy);

    expect(result).toBeNull();
  });

  it("decodes base64 payloads to compute byte length", () => {
    const policy: UploadPolicy = { allowedMediaTypes: "*", maxBytes: 4 };
    const body = Buffer.from("hello world", "utf8").toString("base64");
    const part = filePart({ data: body, mediaType: "text/plain" });
    const result = evaluateFilePart(part, policy);

    expect(result?.kind).toBe("too-large");
    if (result?.kind === "too-large") {
      expect(result.byteLength).toBe(11);
    }
  });

  it("decodes data-URL base64 payloads to compute byte length", () => {
    const policy: UploadPolicy = { allowedMediaTypes: "*", maxBytes: 1 };
    const dataUrl = `data:text/plain;base64,${Buffer.from("hello", "utf8").toString("base64")}`;
    const part = filePart({ data: dataUrl, mediaType: "text/plain" });
    const result = evaluateFilePart(part, policy);

    expect(result?.kind).toBe("too-large");
    if (result?.kind === "too-large") {
      expect(result.byteLength).toBe(5);
    }
  });

  it("rejects every part as disallowed-media-type under 'disabled'", () => {
    const part = filePart({ data: new URL("https://example.com/x"), mediaType: "image/png" });
    const result = evaluateFilePart(part, "disabled");

    expect(result?.kind).toBe("disallowed-media-type");
    if (result?.kind === "disallowed-media-type") {
      expect(result.allowedMediaTypes).toEqual([]);
      expect(result.mediaType).toBe("image/png");
    }
  });
});

describe("collectUploadPolicyViolations", () => {
  it("returns an empty array for plain-text messages", () => {
    expect(collectUploadPolicyViolations("hi", DEFAULT_UPLOAD_POLICY)).toEqual([]);
  });

  it("returns every violation in iteration order", () => {
    const policy: UploadPolicy = {
      allowedMediaTypes: ["text/csv"],
      maxBytes: 4,
    };
    const content: UserContent = [
      { type: "text", text: "summarize" },
      filePart({ data: makeBytes(64), filename: "too-big.csv", mediaType: "text/csv" }),
      filePart({ filename: "nope.png", mediaType: "image/png" }),
      filePart({ data: makeBytes(1), filename: "ok.csv", mediaType: "text/csv" }),
    ];

    const violations = collectUploadPolicyViolations(content, policy);

    expect(violations).toHaveLength(2);
    expect(violations[0]?.kind).toBe("too-large");
    expect(violations[0]?.filename).toBe("too-big.csv");
    expect(violations[1]?.kind).toBe("disallowed-media-type");
    expect(violations[1]?.filename).toBe("nope.png");
  });

  it("skips non-file parts", () => {
    const content: UserContent = [
      { type: "text", text: "hello" },
      { type: "image", mediaType: "image/png", image: makeBytes(8) },
    ];

    expect(collectUploadPolicyViolations(content, { allowedMediaTypes: [], maxBytes: 1 })).toEqual(
      [],
    );
  });
});

describe("stripDisallowedFileParts", () => {
  it("removes violating file parts and keeps text/image parts", () => {
    const policy: UploadPolicy = {
      allowedMediaTypes: ["text/csv"],
      maxBytes: 4,
    };
    const content: UserContent = [
      { type: "text", text: "hi" },
      filePart({ data: makeBytes(1), filename: "keep.csv", mediaType: "text/csv" }),
      filePart({ data: makeBytes(64), filename: "drop-size.csv", mediaType: "text/csv" }),
      filePart({ filename: "drop-type.png", mediaType: "image/png" }),
    ];

    const stripped = stripDisallowedFileParts(content, policy);

    expect(Array.isArray(stripped)).toBe(true);
    expect(stripped).toHaveLength(2);
    const parts = stripped as ReadonlyArray<FilePart | { type: "text"; text: string }>;
    expect(parts[0]).toEqual({ type: "text", text: "hi" });
    expect((parts[1] as FilePart).filename).toBe("keep.csv");
  });

  it("returns the input unchanged for plain strings", () => {
    expect(stripDisallowedFileParts("untouched", DEFAULT_UPLOAD_POLICY)).toBe("untouched");
  });
});

describe("formatUploadPolicyViolation", () => {
  it("renders too-large violations with byte count and limit", () => {
    const violation: UploadPolicyViolation = {
      byteLength: 100,
      filename: "big.csv",
      kind: "too-large",
      limit: 10,
      mediaType: "text/csv",
    };

    const message = formatUploadPolicyViolation(violation);
    expect(message).toContain("big.csv");
    expect(message).toContain("100");
    expect(message).toContain("10");
  });

  it("renders disallowed-type violations with the allowed list", () => {
    const violation: UploadPolicyViolation = {
      allowedMediaTypes: ["text/csv"],
      filename: "photo.png",
      kind: "disallowed-media-type",
      mediaType: "image/png",
    };

    const message = formatUploadPolicyViolation(violation);
    expect(message).toContain("photo.png");
    expect(message).toContain("image/png");
    expect(message).toContain("text/csv");
  });

  it("falls back to media type when filename is absent", () => {
    const violation: UploadPolicyViolation = {
      allowedMediaTypes: [],
      kind: "disallowed-media-type",
      mediaType: "application/x-blob",
    };

    const message = formatUploadPolicyViolation(violation);
    expect(message).toContain("application/x-blob");
  });
});
